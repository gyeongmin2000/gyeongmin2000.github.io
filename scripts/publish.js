require('dotenv').config();
const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const axios = require('axios'); // 이미지 다운로드를 위해 추가

// --- 1. 초기 설정 ---
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// --- 2. API 클라이언트 초기화 ---
const notion = new Client({ auth: NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

// --- 3. 경로 설정 ---
const hugoContentPathKo = path.join(__dirname, '..', 'content', 'ko', 'posts');
const hugoContentPathJa = path.join(__dirname, '..', 'content', 'ja', 'posts');
const hugoImagesPath = path.join(__dirname, '..', 'static', 'images', 'posts'); // 이미지 저장 경로

// --- 4. 헬퍼 함수 ---
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

// --- 5. 이미지 처리 및 notion-to-md 커스텀 설정 ---
// Notion 이미지 블록을 처리하는 커스텀 트랜스포머
n2m.setCustomTransformer("image", async (block) => {
    const { image } = block;
    const imageUrl = image.type === "external" ? image.external.url : image.file.url;
    const blockId = block.id;

    try {
        // 이미지 파일 확장자 추출 (없으면 jpg로 가정)
        const extension = path.extname(new URL(imageUrl).pathname) || '.jpg';
        const localImageName = `${blockId}${extension}`;
        const localImagePath = path.join(hugoImagesPath, localImageName);

        // 이미지를 다운로드하여 static 폴더에 저장
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream',
        });
        response.data.pipe(fs.createWriteStream(localImagePath));

        await new Promise((resolve, reject) => {
            response.data.on('end', resolve);
            response.data.on('error', reject);
        });

        console.log(`  🖼️ 이미지 다운로드 완료: ${localImageName}`);
        
        // 마크다운 이미지 구문을 로컬 경로로 반환
        const caption = image.caption.map(c => c.plain_text).join('');
        return `![${caption}](/images/posts/${localImageName})`;

    } catch (error) {
        console.error(`💥 이미지 처리 중 오류 발생 (URL: ${imageUrl}):`, error.message);
        return ``;
    }
});

// --- 6. 번역 함수 ---
async function translateSimpleText(text, targetLang = 'Japanese') {
  // (이전과 동일한 번역 함수)
  const prompt = `Translate the following Korean text to ${targetLang}. Respond with only the translated text, nothing else.\n\nKorean: "${text}"`;
  try {
    const result = await model.generateContent(prompt);
    let translated = result.response.text().trim();
    if (translated.startsWith('"') && translated.endsWith('"')) {
      translated = translated.substring(1, translated.length - 1);
    }
    return translated;
  } catch (error) {
    console.error(`💥 Gemini API 번역 중 오류 발생 (Text: ${text}):`, error);
    return text;
  }
}

// --- 7. 글 목록 조회 함수 ---
async function getPagesToPublish() {
    // (이전과 동일한 조회 함수)
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
      // 마크다운 변환 (이 과정에서 이미지 다운로드가 자동으로 실행됩니다)
      const mdblocks = await n2m.pageToMarkdown(pageId);
      const koBody = n2m.toMarkdownString(mdblocks).parent.trim();
      
      const koFrontMatter = `---
title: "${titleKo.replace(/"/g, '\\"')}"
date: ${getPropertyValue(PublishedDate)}
tags: [${getPropertyValue(Tags).map(tag => `"${tag}"`).join(', ')}]
---`;
      const koContent = `${koFrontMatter}\n\n${koBody}`;
      
      const koFilePath = path.join(hugoContentPathKo, `${slug}.ko.md`);
      fs.writeFileSync(koFilePath, koContent, 'utf-8');
      console.log(`  ✅ 한국어 파일 저장 완료: ${koFilePath}`);
      
      // 제목과 본문 번역
      const titleJa = await translateSimpleText(titleKo);
      const jaBody = await translateSimpleText(koBody);

      const jaFrontMatter = `---
title: "${titleJa.replace(/"/g, '\\"')}"
date: ${getPropertyValue(PublishedDate)}
tags: [${getPropertyValue(Tags).map(tag => `"${tag}"`).join(', ')}]
---`;
      let jaContent = `${jaFrontMatter}\n\n${jaBody}`;

      if (jaContent.startsWith('\uFEFF')) {
          jaContent = jaContent.slice(1);
      }
      
      const jaFilePath = path.join(hugoContentPathJa, `${slug}.ja.md`);
      fs.writeFileSync(jaFilePath, jaContent, 'utf-8');
      console.log(`  ✅ 일본어 파일 저장 완료: ${jaFilePath}`);
      
      // Notion 페이지 상태 업데이트
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

main();