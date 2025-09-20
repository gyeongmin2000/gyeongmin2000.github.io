/**
 * Notion to Hugo Multilingual Publisher with Gemini AI
 *
 * 이 스크립트는 Notion 데이터베이스에서 'Ready to Publish' 상태의 글을 가져와
 * Hugo에서 사용할 수 있는 다국어(한국어/일본어) 마크다운 파일로 변환합니다.
 * 이미지 다운로드, AI 번역, Notion 상태 업데이트까지 모든 과정을 자동화합니다.
 */

// --- 1. 필수 모듈 불러오기 ---
require('dotenv').config(); // .env 파일의 환경 변수를 로드
const { Client } = require('@notionhq/client'); // Notion API 클라이언트
const { NotionToMarkdown } = require('notion-to-md'); // Notion 콘텐츠 -> 마크다운 변환기
const { GoogleGenerativeAI } = require('@google/generative-ai'); // Gemini AI 클라이언트
const fs = require('fs'); // 파일 시스템 (파일 읽기/쓰기)
const path = require('path'); // 파일 및 디렉토리 경로 처리
const axios = require('axios'); // HTTP 클라이언트 (이미지 다운로드용)

// --- 2. 초기 설정 및 API 클라이언트 초기화 ---
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Notion 클라이언트 (페이지 변환 및 상태 업데이트에 사용)
const notion = new Client({ auth: NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Gemini AI 클라이언트
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

// --- 3. 경로 설정 ---
const hugoContentPathKo = path.join(__dirname, '..', 'content', 'ko', 'posts');
const hugoContentPathJa = path.join(__dirname, '..', 'content', 'ja', 'posts');
const hugoImagesPath = path.join(__dirname, '..', 'static', 'images', 'posts'); // 다운로드된 이미지가 저장될 경로

// --- 4. 헬퍼 함수: Notion 속성 값 추출 ---
// Notion API 응답의 복잡한 구조에서 필요한 값을 쉽게 꺼내기 위한 함수
const getPropertyValue = (property) => {
  if (!property) return '';
  switch (property.type) {
    case 'title': return property.title[0]?.plain_text ?? '';
    case 'rich_text': return property.rich_text[0]?.plain_text ?? '';
    case 'multi_select': return property.multi_select.map(tag => tag.name);
    case 'date': return property.date?.start ?? '';
    default: return '';
  }
};

// --- 5. 이미지 처리 로직 (notion-to-md 커스텀 트랜스포머) ---
// notion-to-md가 'image' 타입 블록을 만났을 때 기본 동작 대신 이 함수를 실행하도록 설정
n2m.setCustomTransformer("image", async (block) => {
    const { image } = block;
    // Notion 이미지 URL (외부 이미지 또는 Notion에 업로드된 파일)
    const imageUrl = image.type === "external" ? image.external.url : image.file.url;
    const blockId = block.id;

    try {
        // 이미지 파일 확장자 추출 (없으면 .jpg로 기본 설정)
        const extension = path.extname(new URL(imageUrl).pathname) || '.jpg';
        const localImageName = `${blockId}${extension}`;
        const localImagePath = path.join(hugoImagesPath, localImageName);

        // axios를 사용해 이미지 URL에서 데이터를 스트림 형태로 다운로드
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream',
        });
        
        // 다운로드한 데이터를 static/images/posts 폴더에 파일로 저장
        response.data.pipe(fs.createWriteStream(localImagePath));

        // 다운로드가 완료될 때까지 기다림
        await new Promise((resolve, reject) => {
            response.data.on('end', resolve);
            response.data.on('error', reject);
        });

        console.log(`  🖼️  이미지 다운로드 완료: ${localImageName}`);
        
        // 최종적으로 마크다운에서 사용할 로컬 경로를 반환
        const caption = image.caption.map(c => c.plain_text).join('');
        return `![${caption}](/images/posts/${localImageName})`;

    } catch (error) {
        console.error(`💥 이미지 처리 중 오류 발생 (URL: ${imageUrl}):`, error.message);
        return ``;
    }
});


// --- 6. 번역 함수 ---

/**
 * 간단한 텍스트(주로 제목)를 번역하는 함수
 * @param {string} text - 번역할 한국어 텍스트
 * @param {string} [targetLang='Japanese'] - 목표 언어
 * @returns {Promise<string>} 번역된 텍스트
 */
async function translateSimpleText(text, targetLang = 'Japanese') {
  const prompt = `Translate the following Korean text to ${targetLang}. Respond with only the translated text, nothing else.\n\nKorean: "${text}"`;
  try {
    const result = await model.generateContent(prompt);
    let translated = result.response.text().trim();
    // AI가 가끔 결과에 따옴표를 포함하는 경우 제거
    if (translated.startsWith('"') && translated.endsWith('"')) {
      translated = translated.substring(1, translated.length - 1);
    }
    return translated;
  } catch (error) {
    console.error(`💥 Gemini API 제목 번역 중 오류 발생 (Text: ${text}):`, error);
    return text; // 번역 실패 시 원본 텍스트 반환
  }
}

/**
 * 마크다운 본문(코드를 포함)을 안전하게 번역하는 함수
 * @param {string} body - 번역할 마크다운 본문
 * @returns {Promise<string>} 번역된 마크다운 본문
 */

async function translateBody(body) {
  // 정규식을 사용해 코드 블록(```)과 인라인 코드(`)를 모두 찾음
  const regex = /(```[\s\S]*?```|`[^`]+`)/g;
  // 본문을 텍스트와 코드 조각으로 분리 (split의 구분자도 배열에 포함시키도록 수정)
  const parts = body.split(regex).filter(Boolean);

  const translatedParts = [];

  for (const part of parts) {
    // 현재 조각이 코드인지 확인
    if (regex.test(part)) {
      // 코드이면 번역하지 않고 그대로 추가
      translatedParts.push(part);
    } else if (part.trim() !== '') {
      // 코드가 아닌 일반 텍스트이면 번역 수행
      const prompt = `Translate the following Korean text fragment to Japanese. Respond with only the translated text, nothing else.\n\nKorean: "${part}"`;
      try {
        const result = await model.generateContent(prompt);
        let translated = result.response.text().trim();
        if (translated.startsWith('"') && translated.endsWith('"')) {
          translated = translated.substring(1, translated.length - 1);
        }
        // 원본의 앞뒤 공백을 최대한 유지하기 위해, 번역 결과 앞뒤에 원본 공백을 붙여줌
        const leadingSpace = part.match(/^\s*/)[0];
        const trailingSpace = part.match(/\s*$/)[0];
        translatedParts.push(leadingSpace + translated + trailingSpace);

      } catch (error) {
        console.error(`💥 Gemini API 본문 번역 중 오류 발생 (Fragment: ${part}):`, error);
        translatedParts.push(part); // 번역 실패 시 원본 조각 사용
      }
    } else {
        // 공백만 있는 조각은 그대로 유지
        translatedParts.push(part);
    }
  }

  // 번역된 조각과 원본 코드 조각을 합쳐 최종 본문을 만듦
  return translatedParts.join('');
}


// --- 7. 글 목록 조회 함수 ---
// Notion API 라이브러리와의 충돌을 피하기 위해 fetch를 사용하여 안정적으로 글 목록을 가져옴
async function getPagesToPublish() {
    try {
        const apiResponse = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${NOTION_API_KEY}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ filter: { property: 'Status', select: { equals: 'Ready to Publish' } } }),
        });
        if (!apiResponse.ok) {
            const errorData = await apiResponse.json();
            throw new Error(`Notion API Error: ${errorData.message}`);
        }
        return (await apiResponse.json()).results;
    } catch (error) {
        console.error("💥 글 목록을 가져오는 중 오류 발생:", error.message);
        return [];
    }
}

// --- 8. 메인 실행 함수 ---
async function main() {
  console.log('🚀 스크립트를 시작합니다...');
  
  const pagesToPublish = await getPagesToPublish();
  if (pagesToPublish.length === 0) {
    console.log('✅ 발행할 글이 없습니다. 스크립트를 종료합니다.');
    return;
  }

  console.log(`총 ${pagesToPublish.length}개의 글을 찾았습니다. 변환을 시작합니다...`);

  for (const page of pagesToPublish) {
    const { id: pageId, properties } = page;
    const { Title, Slug, Tags, PublishedDate } = properties;
    const titleKo = getPropertyValue(Title);
    const slug = getPropertyValue(Slug);

    if (!titleKo || !slug) {
      console.warn(`⚠️ "${titleKo || pageId}" 글에 제목이나 Slug가 없어 건너뜁니다.`);
      continue;
    }

    try {
      console.log(`- "${titleKo}" 글 처리를 시작합니다...`);
      
      // 마크다운 변환 (이 과정에서 위에 설정한 이미지 처리 로직이 자동으로 실행됨)
      const mdblocks = await n2m.pageToMarkdown(pageId);
      const koBody = n2m.toMarkdownString(mdblocks).parent.trim();
      
      // 한국어 Front Matter 생성
      const koFrontMatter = `---
title: "${titleKo.replace(/"/g, '\\"')}"
date: ${getPropertyValue(PublishedDate)}
tags: [${getPropertyValue(Tags).map(tag => `"${tag}"`).join(', ')}]
---`;
      const koContent = `${koFrontMatter}\n\n${koBody}`;
      
      const koFilePath = path.join(hugoContentPathKo, `${slug}.ko.md`);
      fs.writeFileSync(koFilePath, koContent, 'utf-8');
      console.log(`  ✅ 한국어 파일 저장 완료: ${koFilePath}`);
      
      // 제목과 본문을 별도로 번역
      const titleJa = await translateSimpleText(titleKo);
      const jaBody = await translateBody(koBody);

      // 번역된 내용으로 일본어 Front Matter 및 콘텐츠 조립
      const jaFrontMatter = `---
title: "${titleJa.replace(/"/g, '\\"')}"
date: ${getPropertyValue(PublishedDate)}
tags: [${getPropertyValue(Tags).map(tag => `"${tag}"`).join(', ')}]
---`;
      let jaContent = `${jaFrontMatter}\n\n${jaBody}`;

      // Hugo의 Front Matter 파싱 오류를 방지하기 위해 BOM 문자 제거
      if (jaContent.startsWith('\uFEFF')) {
          jaContent = jaContent.slice(1);
      }
      
      const jaFilePath = path.join(hugoContentPathJa, `${slug}.ja.md`);
      fs.writeFileSync(jaFilePath, jaContent, 'utf-8');
      console.log(`  ✅ 일본어 파일 저장 완료: ${jaFilePath}`);
      
      // Notion 페이지 상태를 'Published'로 업데이트하여 중복 발행 방지
      await notion.pages.update({
        page_id: pageId,
        properties: { 'Status': { select: { name: 'Published' } } },
      });
      console.log(`  ✅ "${titleKo}" 상태 업데이트 완료.`);

    } catch (error) {
      console.error(`💥 "${titleKo}" 글 처리 중 오류 발생:`, error.message);
    }
  }
}

// --- 스크립트 실행 ---
main();