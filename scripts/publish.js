// publish.js (최종 완성본: fetch + 번역 + 상태 업데이트)

require('dotenv').config();
const { Client } = require('@notionhq/client');
const { NotionToMarkdown } = require('notion-to-md');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// ==================================================================
// 초기 설정 및 API 클라이언트
// ==================================================================
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Notion 클라이언트 (변환 및 페이지 업데이트 전용)
const notion = new Client({ auth: NOTION_API_KEY });
const n2m = new NotionToMarkdown({ notionClient: notion });

// Gemini 클라이언트
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});

// Hugo 콘텐츠 폴더 경로
const hugoContentPathKo = path.join(__dirname, '..', 'content', 'ko', 'posts');
const hugoContentPathJa = path.join(__dirname, '..', 'content', 'ja', 'posts');

// ==================================================================
// 헬퍼 및 번역 함수
// ==================================================================
const getPropertyValue = (property) => {
  if (!property) return '';
  switch (property.type) {
    case 'title': return property.title[0]?.plain_text || '';
    case 'rich_text': return property.rich_text[0]?.plain_text || '';
    case 'multi_select': return property.multi_select.map(tag => tag.name);
    case 'date': return property.date?.start || '';
    default: return '';
  }
};

// publish.js 파일의 translateText 함수를 이걸로 교체하세요.

async function translateText(text) {
  const placeholders = [];
  const placeholderPrefix = "___PLACEHOLDER_";
  const placeholderSuffix = "___";
  
  // 1. 코드 블록(```)과 인라인 코드(`)를 모두 찾아 플레이스홀더로 교체합니다.
  const textWithoutCode = text.replace(/```[\s\S]*?```|`[^`]+`/g, (match) => {
    const placeholder = `${placeholderPrefix}${placeholders.length}${placeholderSuffix}`;
    placeholders.push(match);
    return placeholder;
  });

  // 2. 코드가 제거된 텍스트만 번역합니다.
  const prompt = `Korean technical blog post를 natural Japanese으로 번역해줘. Markdown 포맷, front matter 구조는 그대로 유지하고, front matter의 'title' 필드만 번역해줘. 번역된 Markdown 결과물만 응답해줘. 서론은 필요 없어. 번역할 내용: --- ${textWithoutCode}`;
  
  let translatedText;
  try {
    const result = await model.generateContent(prompt);
    translatedText = result.response.text();
  } catch (error) {
    console.error("💥 Gemini API 번역 중 오류 발생:", error);
    throw new Error("Translation failed.");
  }

  // 3. 번역된 텍스트에 원래의 코드 조각들을 다시 삽입합니다.
  let finalContent = translatedText;
  for (let i = 0; i < placeholders.length; i++) {
    const placeholder = `${placeholderPrefix}${i}${placeholderSuffix}`;
    finalContent = finalContent.replace(placeholder, placeholders[i]);
  }

  return finalContent;
}

// ==================================================================
// 메인 실행 함수
// ==================================================================
async function main() {
  console.log('🚀 스크립트를 시작합니다...');

  let pagesToPublish = [];

  // 1. fetch를 이용해 발행할 페이지 목록을 가져옵니다.
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
    pagesToPublish = data.results;

  } catch (error) {
    console.error("💥 글 목록을 가져오는 중 오류 발생:", error.message);
    return;
  }

  if (pagesToPublish.length === 0) {
    console.log('✅ 발행할 글이 없습니다. 스크립트를 종료합니다.');
    return;
  }

  console.log(`총 ${pagesToPublish.length}개의 글을 찾았습니다. 변환을 시작합니다...`);

  for (const page of pagesToPublish) {
    const pageId = page.id;
    const properties = page.properties;
    const title = getPropertyValue(properties.Title);
    const slug = getPropertyValue(properties.Slug);

    if (!title || !slug) {
      console.warn(`⚠️ "${title || pageId}" 글에 제목이나 Slug가 없어 건너뜁니다.`);
      continue;
    }

    try {
      // 2. 한국어 마크다운 생성 (n2m 사용)
      console.log(`- "${title}" (ko) 글을 마크다운으로 변환합니다...`);
      const frontMatter = `---
title: "${title.replace(/"/g, '\\"')}"
date: ${getPropertyValue(properties.PublishedDate)}
tags: [${getPropertyValue(properties.Tags).map(tag => `"${tag}"`).join(', ')}]
---`;
      const mdblocks = await n2m.pageToMarkdown(pageId);
      const koContent = `${frontMatter}\n\n${n2m.toMarkdownString(mdblocks).parent}`;
      const koFilePath = path.join(hugoContentPathKo, `${slug}.ko.md`);
      fs.writeFileSync(koFilePath, koContent, 'utf-8');
      console.log(`  ✅ 한국어 파일 저장 완료: ${koFilePath}`);

      // 3. 일본어 번역 (Gemini 사용)
      console.log(`- "${title}" (ja) 글로 번역을 시작합니다...`);
      const jaContent = await translateText(koContent);
      const jaFilePath = path.join(hugoContentPathJa, `${slug}.ja.md`);
      fs.writeFileSync(jaFilePath, jaContent, 'utf-8');
      console.log(`  ✅ 일본어 파일 저장 완료: ${jaFilePath}`);
      
      // 4. Notion 페이지 상태 업데이트 (notion.pages.update 사용)
      console.log(`- "${title}" 글의 상태를 'Published'로 업데이트합니다...`);
      await notion.pages.update({
        page_id: pageId,
        properties: { 'Status': { select: { name: 'Published' } } },
      });
      console.log(`  ✅ 상태 업데이트 완료.`);

    } catch (error) {
      console.error(`💥 "${title}" 글 처리 중 오류 발생:`, error.message);
    }
  }
}

main();