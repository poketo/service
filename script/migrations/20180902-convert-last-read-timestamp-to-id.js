#!/usr/bin/env node

const got = require('got');

const apiBase = 'http://localhost:3001'; // 'https://api.poketo.app';
const collectionSlug = ADD_YOUR_COLLECTION_SLUG_HERE;
const api = got.extend({
  baseUrl: apiBase,
  json: true,
});

console.log(`Running for ${collectionSlug} on ${apiBase}`);

const invariant = (condition, message) => {
  if (condition) {
    return;
  }

  throw new Error(message);
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const isNumber = val => {
  return Boolean(val) && !Number.isNaN(val);
};

const sortChapters = arr => {
  return arr.slice().sort((a, b) => {
    const chapterA = parseFloat(a.chapterNumber);
    const volumeA = parseFloat(a.volumeNumber);
    const chapterB = parseFloat(b.chapterNumber);
    const volumeB = parseFloat(b.volumeNumber);

    if (isNumber(volumeA) && isNumber(volumeB)) {
      if (volumeA < volumeB) {
        return 1;
      }

      if (volumeA > volumeB) {
        return -1;
      }
    }

    if (!isNumber(chapterB)) {
      return -1;
    }

    if (!isNumber(chapterA)) {
      return 1;
    }

    return chapterB - chapterA;
  });
};

const getNewestChapterId = chapters => chapters.shift().id;

const getLastReadChapterForSeries = async (bookmark, seriesId) => {
  let series;

  try {
    const res = await api(`/series?id=${seriesId}`);
    series = res.body;
  } catch (err) {
    console.log('Errored for', seriesId, `(${err.message})`);
    return null;
  }

  invariant(series, 'No series!');
  invariant(bookmark, 'No bookmark!');

  if (!series.supportsReading) {
    return null;
  }

  const chapters = sortChapters(series.chapters);
  const alreadyReadChapters = chapters.filter(
    chapter => chapter.createdAt <= bookmark.lastReadAt,
  );

  if (alreadyReadChapters.length === chapters.length) {
    return getNewestChapterId(series.chapters);
  }

  const lastReadChapterNumber =
    alreadyReadChapters.length > 0
      ? getNewestChapterId(alreadyReadChapters)
      : null;

  return lastReadChapterNumber;
};

const getLastReadChapters = async collectionSlug => {
  const { body: collection } = await api(`/collection/${collectionSlug}`);

  invariant(collection, 'No collection!');

  const bookmarks = Object.values(collection.bookmarks);
  const result = {};

  let i = 0;
  for (const bookmark of bookmarks) {
    // Added delay to avoid over-fetching from sites
    await delay(500);
    const chapterId = await getLastReadChapterForSeries(bookmark, bookmark.id);

    result[bookmark.id] = chapterId;
    console.log('Fetched', `${i++} of ${bookmarks.length}`);
  }

  return result;
};

async function migrateCollection(collectionSlug) {
  const chapterMap = await getLastReadChapters(collectionSlug);
  const tasks = [];

  for (const [seriesId, lastReadChapterId] of Object.entries(chapterMap)) {
    tasks.push(
      api
        .post(`/collection/${collectionSlug}/bookmark/${seriesId}/read`, {
          body: { lastReadChapterId },
        })
        .then(() => {
          console.log('Updated', seriesId, 'to', lastReadChapterId);
        }),
    );
  }

  await Promise.all(tasks);

  console.log('Done');
}

async function main() {
  await migrateCollection(collectionSlug);
}

main().catch(err => {
  console.error(err, err.body);
  process.exit(1);
});

// NOTE:
// const lastChapter = chapters.find(chapter => chapter.id === lastReadChapterId);
// const unreadChapters = chapters.filter(c => c.order > lastChapter.order);
// const newChapters = chapters.filter(c => c.createdAt > bookmark.addedAt);
// const showNewChapters = unreadChapters.length < 5;
