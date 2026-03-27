const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs-extra");
const { execSync } = require("child_process");

const BASE = "https://myserieshd.com";
const API = BASE + "/wp-content/themes/getplayer-2025/framework/get-video.php";

// 🔥 MODE
const MODE = process.env.MODE || "update"; // full | update | test
const TEST_LIMIT = 1;
const TEST_URL = process.env.TEST_URL || null;

// 🔥 commit ทุกกี่เรื่อง
const COMMIT_EVERY = 10;

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

// =========================
// 🔥 COMMIT FUNCTION (กันพัง)
// =========================
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

  const title = $("h1.single-title").text().trim();
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

// =========================

async function runCategory(name, path) {
  console.log(`\n📂 CATEGORY: ${name}`);

  let page = progress[name]?.page || 1;
  let doneUrls = progress[name]?.done || [];

  let results = fs.existsSync(`data/${name}.json`)
    ? fs.readJsonSync(`data/${name}.json`)
    : [];
  let emptyPageCount = 0;


  while (true) {
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
  // 🔥 ถ้ามี links = reset counter
  
}

    // 🧪 TEST MODE
    if (MODE === "test") {
      console.log("🧪 TEST MODE");
      links = TEST_URL ? [TEST_URL] : links.slice(0, TEST_LIMIT);
    }

    let count = 0;
    let newItemInPage = false;
  
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

            existing.episodes.push(...data.newEpisodes);

            // 🔥 sort ด้วย ep
            existing.episodes.sort((a, b) => b.ep - a.ep);

            console.log(`✨ UPDATE ${data.title} +${data.newEpisodes.length}`);
          }

        } else {

          results.push({
            title: data.title,
            image: data.image,
            link,
            updated_at: Date.now(),
            episodes: data.newEpisodes
          });

          console.log(`🆕 NEW ${data.title}`);

          newItemInPage = true;
        }

        doneUrls.push(link);

        await fs.writeJson(`data/${name}.json`, results, { spaces: 2 });

        progress[name] = { page, done: doneUrls };
        await fs.writeJson("progress.tmp.json", progress, { spaces: 2 });
        await fs.move("progress.tmp.json", "progress.json", { overwrite: true });

        processedCount++;
        count++;

        // 🔥 commit ทุก 10 เรื่อง
        if (processedCount % COMMIT_EVERY === 0) {
          autoCommit();
        }

      } catch {
        console.log("❌ ERROR:", link);
      }
    }

if (!newItemInPage) {
  emptyPageCount++;
  console.log("⚠️ ไม่มีเรื่องใหม่ในหน้านี้");

  if (emptyPageCount >= 2) {
    console.log("🛑 ไม่มีเรื่องใหม่ 2 หน้า → จบหมวด");
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
}

// =========================

(async () => {
  await fs.ensureDir("data");

  console.log(`🚀 MODE: ${MODE}`);

  for (let [name, path] of Object.entries(CATEGORIES)) {
    await runCategory(name, path);
  }

  autoCommit(); // 🔥 commit ปิดท้าย

  console.log("\n🎉 ALL DONE");
})();