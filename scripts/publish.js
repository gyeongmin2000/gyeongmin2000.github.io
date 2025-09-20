require('dotenv').config();
const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

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

// --- 5. 번역 함수 ---
// 이제 순수 텍스트만 번역하도록 수정되었습니다.
async function translateSimpleText(text, targetLang = 'Japanese') {
  const prompt = `Translate the following Korean text to ${targetLang}. Respond with only the translated text, nothing else.\n\nKorean: "${text}"`;
  try {
    const result = await model.generateContent(prompt);
    let translated = result.response.text().trim();
    // 가끔 번역 결과에 따옴표가 포함되는 경우 제거
    if (translated.startsWith('"') && translated.endsWith('"')) {
      translated = translated.substring(1, translated.length - 1);
    }
    return translated;
  } catch (error) {
    console.error(`💥 Gemini API 번역 중 오류 발생 (Text: ${text}):`, error);
    // 번역 실패 시 원본 텍스트 반환
    return text;
  }
}

// --- 6. 글 목록 조회 함수 ---
async function getPagesToPublish() {
    try {
        const apiResponse = await fetch(`https://api.notion.com/v1/databases/${DATABASE_ID}/query`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${NOTION_API_KEY}`,
                'Content-Type': 'application/json',
                'Notion-Version': '2022-06-28',
            },
            body: JSON.stringify({
                filter: { property: 'Status', select: { equals: 'Ready to Publish' } },
            }),
        });
        if (!apiResponse.ok) {
            const errorData = await apiResponse.json();
            throw new Error(`Notion API Error: ${errorData.message}`);
        }
        const data = await apiResponse.json();
        return data.results;
    } catch (error) {
        console.error("💥 글 목록을 가져오는 중 오류 발생:", error.message);
        return [];
    }
}

// --- 7. 메인 실행 함수 ---
async function main() {
  console.log('🚀 스크립트를 시작합니다...');
  
  const pagesToPublish = await getPagesToPublish();

  if (pagesToPublish.length === 0) {
    console.log('✅ 발행할 글이 없습니다. 스크립트를 종료합니다.');
    return;
  }

  console.log(`총 ${pagesToPublish.length}개의 글을 찾았습니다. 변환을 시작합니다...`);

  for (const page of pagesToPublish) {
    const pageId = page.id;
    const { Title, Slug, Tags, PublishedDate } = page.properties;
    const titleKo = getPropertyValue(Title);
    const slug = getPropertyValue(Slug);

    if (!titleKo || !slug) {
      console.warn(`⚠️ "${titleKo || pageId}" 글에 제목이나 Slug가 없어 건너뜁니다.`);
      continue;
    }

    try {
      // 1. 한국어 콘텐츠 생성
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
      
      // 2. 제목과 본문을 **별도로** 번역
      console.log(`- "${titleKo}" 글을 일본어로 번역합니다...`);
      const titleJa = await translateSimpleText(titleKo);
      const jaBody = await translateSimpleText(koBody);

      // 3. 번역된 내용으로 일본어 Front Matter 및 콘텐츠 조립
      const jaFrontMatter = `---
title: "${titleJa.replace(/"/g, '\\"')}"
date: ${getPropertyValue(PublishedDate)}
tags: [${getPropertyValue(Tags).map(tag => `"${tag}"`).join(', ')}]
---`;
      let jaContent = `${jaFrontMatter}\n\n${jaBody}`;

      // BOM 문자 제거
      if (jaContent.startsWith('\uFEFF')) {
          jaContent = jaContent.slice(1);
      }
      
      const jaFilePath = path.join(hugoContentPathJa, `${slug}.ja.md`);
      fs.writeFileSync(jaFilePath, jaContent, 'utf-8');
      console.log(`  ✅ 일본어 파일 저장 완료: ${jaFilePath}`);
      
      // 4. Notion 페이지 상태 업데이트
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