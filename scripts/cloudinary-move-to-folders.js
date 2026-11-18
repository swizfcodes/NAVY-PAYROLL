// Put emolument photos into Media Library folders on Cloudinary.
//
// On a "dynamic folders" Cloudinary account an image named
// emolument/passport/nn_12345 can still sit in Home: the slashes are only part of
// its name (public_id). This script lists every image whose name starts with
// the prefix and sets its folder (asset_folder) to the name minus the last part:
//   emolument/passport/nn_12345   ->  folder emolument/passport
// Only the folder changes. public_id, URLs and ef_documents stay as they are.
//
//   node scripts/cloudinary-move-to-folders.js                    dry run
//   node scripts/cloudinary-move-to-folders.js --apply            move them
//   node scripts/cloudinary-move-to-folders.js --prefix emolument/pass --apply
//   node scripts/cloudinary-move-to-folders.js --apply --wait   keep going: wait out
//                                                               the hourly limit, then continue
//   node scripts/cloudinary-move-to-folders.js --apply --method explicit --limit 5
//        try the faster way on 5 images: the Upload API "explicit" call, which is not
//        under the Admin API's hourly limit and runs 5 at a time. Check them in the
//        Media Library, then run without --limit.
//
// Only images sitting in Home (no folder) are moved; an image someone already put
// in another folder is listed and left alone. Failures are written to
// cloudinary-move-failed.json next to where you run it.
// Safe to run again: images already in the right folder are skipped. If
// Cloudinary's hourly API limit is reached it stops; run it again later.
// Needs CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET.

require("dotenv").config();
const cloudinary = require("cloudinary").v2;

const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > -1 ? process.argv[i + 1] : null;
};
const APPLY = process.argv.includes("--apply");
const PREFIX = arg("--prefix") || "emolument/";
const WAIT = process.argv.includes("--wait");
const METHOD = arg("--method") === "explicit" ? "explicit" : "update";
const LIMIT = Number(arg("--limit")) || Infinity;
const PARALLEL = METHOD === "explicit" ? 5 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FAILED_FILE = "cloudinary-move-failed.json";
let resetAt = null; // when Cloudinary's hourly allowance resets (from API responses)
const noteLimit = (res) => {
  if (res && res.rate_limit_reset_at) resetAt = new Date(res.rate_limit_reset_at);
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const folderFor = (publicId) => (publicId.includes("/") ? publicId.slice(0, publicId.lastIndexOf("/")) : "");
const isRateLimit = (e) => (e.error && e.error.http_code === 420) || /rate limit/i.test(e.message || (e.error && e.error.message) || "");

async function main() {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary settings missing (CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET).");
  }
  console.log(`Images whose name starts with "${PREFIX}". ${APPLY ? "Moving." : "Dry run (add --apply)."}\n`);

  // 1. list (500 per call)
  const all = [];
  let cursor;
  do {
    const page = await cloudinary.api.resources({
      type: "upload",
      resource_type: "image",
      prefix: PREFIX,
      max_results: 500,
      next_cursor: cursor,
    });
    noteLimit(page);
    all.push(...page.resources);
    cursor = page.next_cursor;
    if (page.rate_limit_remaining != null) process.stdout.write(`  listed ${all.length} (API calls left this hour: ${page.rate_limit_remaining})\r`);
  } while (cursor);
  console.log(`\n${all.length} image(s) found.`);

  const wrong = all.filter((r) => (r.asset_folder || "") !== folderFor(r.public_id));
  const elsewhere = wrong.filter((r) => (r.asset_folder || "") !== "");
  const todo = wrong.filter((r) => (r.asset_folder || "") === "" && folderFor(r.public_id) !== "");
  if (elsewhere.length) {
    console.log(`${elsewhere.length} image(s) are in another folder (not Home) and are left alone, e.g.:`);
    for (const r of elsewhere.slice(0, 10)) console.log(`  ${r.public_id}  (in ${r.asset_folder})`);
  }
  const byFolder = {};
  for (const r of todo) {
    const k = `${r.asset_folder || "(Home)"}  ->  ${folderFor(r.public_id)}`;
    byFolder[k] = (byFolder[k] || 0) + 1;
  }
  console.log(`${all.length - wrong.length} already in the right folder, ${todo.length} to move from Home:`);
  for (const [k, n] of Object.entries(byFolder)) console.log(`  ${n}  ${k}`);
  if (!APPLY || !todo.length) return;
  if (LIMIT < todo.length) todo.length = LIMIT;
  const total = todo.length;
  console.log(`\nMoving ${total} with ${METHOD === "explicit" ? "the Upload API (explicit), 5 at a time" : "the Admin API (update)"}.`);

  const moveOne = (r) => {
    const opts = { resource_type: "image", type: "upload", asset_folder: folderFor(r.public_id) };
    return METHOD === "explicit" ? cloudinary.uploader.explicit(r.public_id, opts) : cloudinary.api.update(r.public_id, opts);
  };

  // 2. move
  let moved = 0, failed = 0, stopped = false, waiting = null;
  const failures = [];
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length && !stopped) {
      if (waiting) await waiting;
      const r = queue.shift();
      if (!r) break;
      try {
        const res = await moveOne(r);
        noteLimit(res);
        if (METHOD === "explicit" && res && res.asset_folder != null && res.asset_folder !== folderFor(r.public_id)) {
          throw new Error(`still in "${res.asset_folder || "Home"}": explicit did not move it, use the default method`);
        }
        moved++;
        if (moved % 100 === 0) console.log(`  ${new Date().toLocaleTimeString()}  moved ${moved} / ${total}`);
      } catch (e) {
        if (isRateLimit(e)) {
          queue.unshift(r); // try this image again
          if (!WAIT) {
            if (!stopped) console.log(`\nCloudinary's hourly API limit reached after ${moved}. Run the same command again later to continue.`);
            stopped = true;
          } else if (!waiting) {
            // wait until the allowance resets (plus a minute), or 10 minutes if unknown
            const ms = resetAt && resetAt > new Date() ? resetAt - new Date() + 60 * 1000 : 10 * 60 * 1000;
            console.log(`  ${new Date().toLocaleTimeString()}  hourly limit reached (${moved} moved so far); waiting ${Math.round(ms / 60000)} min`);
            waiting = sleep(ms).then(() => {
              waiting = null;
              resetAt = null;
            });
          }
          continue;
        }
        failed++;
        const msg = e.message || (e.error && e.error.message);
        failures.push({ public_id: r.public_id, folder: folderFor(r.public_id), error: msg });
        console.log(`  ${r.public_id}: ${msg}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  if (failures.length) {
    require("fs").writeFileSync(FAILED_FILE, JSON.stringify(failures, null, 2));
    console.log(`Failed images written to ${FAILED_FILE}; running the command again retries them.`);
  }
  console.log(`\nMoved ${moved} of ${total}, errors ${failed}. Run the dry run again to see what is left.`);
}

main().catch((e) => {
  console.error("❌", e.message || (e.error && e.error.message) || e);
  process.exit(1);
});
