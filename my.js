const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const { execSync } = require("child_process");
const WISEPLAY_DIR = "wiseplay";
const BASE = "https://myserieshd.com";
const API = BASE + "/wp-content/themes/getplayer-2025/framework/get-video.php";
const DOMAIN = "https://myserieshd.com";
// 🔥 MODE
const MODE = process.env.MODE || "update"; // full | update | test
const TEST_LIMIT = 1;
const TEST_URL = process.env.TEST_URL || null;

const CATEGORIES = {
  new: "/no-end/",
  chinese: "/channel/chinese/",
  korea: "/channel/kr-series-hit/",
  japan: "/channel/series-jp/",
  thai: "/channel/drama-th/",
  short: "/channel/lakorn-drama/"
};

// โหลด progress
let progress = {};

try {
  if (fs.existsSync("progress.json")) {
    progress = fs.readJsonSync("progress.json");
  }
} catch (e) {
  console.log("⚠️ progress.json เสีย → reset");
  progress = {};
}

let processedCount = 0;
let ALL_RESULTS = {};

function autoCommit() {
  try {
    execSync(`git config user.name "github-actions"`);
    execSync(`git config user.email "actions@github.com"`);

    execSync(`git add .`);

    // กัน commit ว่าง
    try {
      execSync(`git diff --cached --quiet`);
      console.log("⚠️ nothing to commit");
      return;
    } catch {}

    execSync(`git commit -m "auto update playlist"`);
    execSync(`git push`);

    console.log("🚀 AUTO COMMIT");
  } catch (e) {
    console.log("⚠️ commit error");
  }
}

// =========================

async function getListPage(url) {

  const res = await axios.get(url, {
    validateStatus: () => true // 🔥 กัน axios error 404
  });

  const html = res.data;
  const $ = cheerio.load(html);

  // =========================
  // 🔥 1. ตรวจ 404 / redirect
  // =========================
  if (
    html.includes("404") ||
    html.toLowerCase().includes("page not found") ||
    html.toLowerCase().includes("redirecting to the homepage")
  ) {
    console.log("🚫 404 PAGE DETECTED");
    return [];
  }

  // =========================
  // 🔥 2. ดึงลิงก์
  // =========================
  const links = $("a.movie-link")
    .map((i, el) => $(el).attr("href"))
    .get();

  // =========================
  // 🔥 3. กันหน้า duplicate (สำคัญ)
  // =========================
  const unique = new Set(links);

  if (links.length > 0 && unique.size < links.length / 2) {
    console.log("🚫 DUPLICATE PAGE DETECTED");
    return [];
  }

  return links;
}

// =========================

async function scrapeDetail(url, existingData) {
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  let title = $("h1.single-title").text().trim();

// 🔥 ตัด prefix ดู + ประเภท (แบบ robust)
title = title
  .replace(/^ดู\s*(ละคร|ซีรี่ย์|ซีรีส์|หนัง)\s*/g, "")
  .replace(/^ดู\s+/g, "")
  .trim();
  const image = $('meta[property="og:image"]').attr("content");
  const postId = $("article").attr("id").replace("post-", "");

  const eps = $(".ep-btn")
    .map((i, el) => $(el).attr("data-ep"))
    .get();

  // 🔥 ใช้ ep number แทน name
  let existingEpSet = new Set();

  if (existingData) {
    existingEpSet = new Set(existingData.episodes.map(e => e.ep));
  }

  let newEpisodes = [];

  for (let ep of eps) {
    const epNum = Number(ep);

    // 🔥 skip ตอนเก่า (เฉพาะ update mode)
    if (MODE !== "full" && existingEpSet.has(epNum)) continue;

    try {
      const res = await axios.post(
        API,
        new URLSearchParams({
          post_id: postId,
          ep_index: ep
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": url
          }
        }
      );

      newEpisodes.push({
        name: `EP${ep}`,
        ep: epNum, // 🔥 สำคัญ
        servers: [
          { name: "main", url: res.data.video_url },
          { name: "backup", url: res.data.backup_video_url }
        ]
      });

      console.log(`   🆕 EP${ep}`);

      await new Promise(r => setTimeout(r, 300));

    } catch {
      console.log(`   ❌ EP${ep}`);
    }
  }

  return { title, image, newEpisodes };
}

function buildWiseplayJSON(groupName, movies) {

  console.log("📺 BUILD WISEPLAY:", groupName)

  const today = new Date().toLocaleDateString("th-TH")

  const output = {
    name: groupName,
    author: today,
    image: "https://myserieshd.com/wp-content/uploads/2025/05/logo1-2.webp",
    url: DOMAIN,
    groups: []
  }

  for (const movie of movies) {

    let group = {
      name: movie.title,
      author: today,
      image: movie.image,
      stations: []
    }

    for (const ep of movie.episodes) {

      group.stations.push({
        name: ep.name.replace("EP","ตอนที่ "),
        image: movie.image,
        url: ep.servers[0].url,
        referer: DOMAIN
      })

    }

    // 🔥 เรียงตอนใหม่ขึ้นบน
    group.stations.sort((a,b)=>{
      const aNum = parseInt(a.name.replace("ตอนที่ ",""))
      const bNum = parseInt(b.name.replace("ตอนที่ ",""))
      return bNum - aNum
    })

    if (group.stations.length > 0) {
      output.groups.push(group)
    }

  }

  const file = `${WISEPLAY_DIR}/${groupName}.json`

  fs.writeFileSync(file, JSON.stringify(output, null, 2))

  console.log("✅ WISEPLAY JSON:", file)
}


function generateIndex(jsonOutput) {
  const baseRaw = "https://raw.githubusercontent.com/Hssmnoy/myseries/main/wiseplay/";

  const index = {
    name: "MyseriesHD",
    author: new Date().toLocaleDateString("th-TH"),
    image: "https://myserieshd.com/wp-content/uploads/2025/05/logo1-2.webp",
    url: "https://myserieshd.com/",
    groups: []
  };

  for (const group in jsonOutput) {
    index.groups.push({
      name: group,
      image: "https://myserieshd.com/wp-content/uploads/2025/05/logo1-2.webp",
      url: `${baseRaw}${group}.json`
    });
  }

  const file = `${WISEPLAY_DIR}/index.json`;

  fs.writeFileSync(file, JSON.stringify(index, null, 2));

  console.log("📦 index.json created");
}

// =========================

async function runCategory(name, path) {
  console.log(`\n📂 CATEGORY: ${name}`);

  let page = 1;
  let doneUrls = progress[name]?.done || [];

  let results = fs.existsSync(`data/${name}.json`)
    ? fs.readJsonSync(`data/${name}.json`)
    : [];
  
  ALL_RESULTS[name] = results; 
  let emptyPageCount = 0;


  while (true) {
    if (page > 3) {
  console.log("🛑 ครบ 3 หน้า → จบหมวด");
  break;
}
    const url = `${BASE}${path}page/${page}/`;
    console.log(`\n📄 Page ${page}`);

    let links;
    try {
      links = await getListPage(url);
    } catch {
      break;
    }

    if (!links.length) {
  emptyPageCount++;
  console.log("⚠️ ไม่มีลิงก์");

  if (emptyPageCount >= 2) {
    console.log("🛑 เจอหน้าว่าง 2 หน้า → จบหมวด");
    break;
  }

  page++;
  continue;

} else {
  emptyPageCount = 0;
  
}

    // 🧪 TEST MODE
    if (MODE === "test") {
      console.log("🧪 TEST MODE");
      links = TEST_URL ? [TEST_URL] : links.slice(0, TEST_LIMIT);
    }

    let count = 0;
    let newItemInPage = false;
    let newEpisodeInPage = false;
    
    for (let link of links) {

  if (MODE === "test" && count >= TEST_LIMIT) {
    console.log("🧪 TEST STOP");
    break;
  }

  console.log(`\n🎬 ${link}`);

  try {
    const existing = results.find(r => r.link === link);

    const data = await scrapeDetail(link, existing);

    if (existing) {

      if (data.newEpisodes.length > 0) {
  newEpisodeInPage = true;

  existing.episodes.push(...data.newEpisodes);
  existing.episodes.sort((a, b) => b.ep - a.ep);

  existing.updated_at = Date.now();

  const index = results.findIndex(x => x.link === existing.link);

  if (index > 0) {
    results.splice(index, 1);
    results.unshift(existing);
  }

  console.log(`✨ UPDATE ${data.title} +${data.newEpisodes.length}`);
}

    } else {

      results.unshift({
        title: data.title,
        image: data.image,
        link,
        updated_at: Date.now(),
        episodes: data.newEpisodes
      });

      newItemInPage = true;
    }

    // ✅ อยู่ใน try
    doneUrls.push(link);

    // ✅ save + progress อยู่ใน try ได้
    await fs.writeJson(`data/${name}.json`, results, { spaces: 2 });

    progress[name] = { page, done: doneUrls };
    await fs.writeJson("progress.tmp.json", progress, { spaces: 2 });
    await fs.move("progress.tmp.json", "progress.json", { overwrite: true });

    processedCount++;
    count++;
  
  } catch (err) {
    console.log("❌ ERROR:", link);
  }
}

if (!newItemInPage && !newEpisodeInPage) {
  emptyPageCount++;
  console.log(`⛔ ไม่มีอะไรใหม่ (${emptyPageCount}/3)`);

  if (emptyPageCount >= 3) {
    console.log("🛑 3 หน้าแรกไม่มีอะไรใหม่ → จบหมวด");
    break;
  }
} else {
  emptyPageCount = 0;
}

if (page > 30) {
  console.log("🛑 LIMIT PAGE STOP");
  break;
}

    page++;
  }

  console.log(`\n✅ DONE ${name}`);

ALL_RESULTS[name] = results;
}

// =========================

(async () => {
  await fs.ensureDir("data");
  await fs.ensureDir(WISEPLAY_DIR);
  console.log(`🚀 MODE: ${MODE}`);

  for (let [name, path] of Object.entries(CATEGORIES)) {
    await runCategory(name, path);
  }

  autoCommit(); // 🔥 commit ปิดท้าย

for (const [name, movies] of Object.entries(ALL_RESULTS)) {
  buildWiseplayJSON(name, movies);
}

generateIndex(ALL_RESULTS);

console.log("\n🎉 ALL DONE");
})();
