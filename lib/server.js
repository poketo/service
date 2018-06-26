// @flow

import Koa from 'koa';
import route from 'koa-route';
import bodyparser from 'koa-bodyparser';
import logger from 'koa-bunyan-logger';
import cors from '@koa/cors';

import pmap from 'p-map';
import shortid from 'shortid';

import poketo from 'poketo';
import db, { Collection } from './db';
import utils from './utils';

const app = new Koa();

app.use(cors());
app.use(bodyparser());
app.use(logger({ name: 'poketo-service' }));

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    let status;
    let code;

    // Handle Poketo error types
    switch (err.code) {
      case 'NOT_FOUND':
        status = 404;
        break;
      case 'INVALID_URL':
      case 'UNSUPPORTED_SITE':
      case 'UNSUPPORTED_SITE_REQUEST':
        status = 400;
        break;
      default:
        status = err.statusCode || err.status || 500;
        break;
    }

    switch (status) {
      case 404:
        code = 'NOT_FOUND';
        break;
      case 400:
        code = 'BAD_REQUEST';
        break;
      default:
        code = 'SERVER_ERROR';
        break;
    }

    ctx.status = status;
    ctx.body = {
      code: err.code || code,
      message: err.statusMessage || err.message,
    };
    ctx.log.error(err, 'Error during request from %s for %s', ctx.request.get('referer'), ctx.path);
    ctx.app.emit('error', err, ctx);
  }
});

app.on('error', () => {});

/**
 * Routes
 *
 * GET     /
 * POST    /collection/new
 * GET     /collection/:slug
 * POST    /collection/:slug/bookmark/new
 * DELETE  /collection/:slug/bookmark/:seriesId
 * POST    /collection/:slug/bookmark/:seriesId/read
 *
 * GET     /series/:url
 * GET     /series/:siteId/:seriesSlug
 * GET     /chapter/:url
 * GET     /chapter/:siteId/:seriesSlug/:chapterSlug
 */

app.use(
  route.get('/', async ctx => {
    ctx.body = '🔖';
  }),
);

app.use(
  route.post('/collection/new', async ctx => {
    const { bookmarks } = ctx.request.body;

    ctx.assert(Array.isArray(bookmarks), 400, `Bookmarks must be an array`);
    ctx.assert(bookmarks.length > 0, 400, `Bookmarks must have at least one series URL`);

    const series = await pmap(
      bookmarks,
      bookmark => poketo.getSeries(bookmark.url),
      { concurrency: 3 },
    );

    const newCollection = new Collection({
      slug: shortid.generate(),
      bookmarks: [],
    });

    series.forEach((s, i) => {
      const bookmark = bookmarks[i];
      newCollection.addBookmark(s, bookmark.linkTo, bookmark.lastReadAt);
    });

    await newCollection.save();

    ctx.body = newCollection;
  }),
);

app.use(
  route.get('/collection/:slug', async (ctx, slug) => {
    const collection = await Collection.findOne({ slug });
    ctx.assert(collection, 404);
    const bookmarks = collection.get('bookmarks');

    ctx.body = {
      slug,
      bookmarks: utils.keyArrayBy(bookmarks, obj => obj.id),
    };
  }),
);

app.use(
  route.post(
    '/collection/:slug/bookmark/new',
    async (ctx, slug) => {
      const collection = await Collection.findOne({ slug });
      ctx.assert(collection, 404);

      const { seriesUrl, linkToUrl = null, lastReadAt } = ctx.request.body;

      ctx.assert(utils.isUrl(seriesUrl), 400, `Invalid URL '${seriesUrl}'`);
      ctx.assert(linkToUrl === null || utils.isUrl(linkToUrl), 400, `Invalid URL '${linkToUrl ? linkToUrl : ''}'`);

      // NOTE: we make a request to the series here to both: (a) validate that
      // we can read and support this series and (b) to normalize the URL and
      // ID through poketo so we're not storing duplicates.
      const series = await poketo.getSeries(seriesUrl);

      collection.addBookmark(series, linkToUrl, lastReadAt);
      await collection.save();

      ctx.body = {
        collection: {
          slug: collection.get('slug'),
          bookmarks: utils.keyArrayBy(collection.get('bookmarks'), obj => obj.id),
        },
        series,
      }
    },
  )
)

app.use(
  route.delete(
    '/collection/:slug/bookmark/:seriesId',
    async (ctx, slug, seriesId) => {
      const collection = await Collection.findOne({ slug });
      ctx.assert(collection, 404);

      collection.removeBookmark(seriesId);
      await collection.save();

      ctx.body = {
        slug: collection.get('slug'),
        bookmarks: utils.keyArrayBy(collection.get('bookmarks'), obj => obj.id),
      };
    }
  )
)

app.use(
  route.post(
    '/collection/:slug/bookmark/:seriesId/read',
    async (ctx, slug, seriesId) => {
      const collection = await Collection.findOne({ slug });
      ctx.assert(collection, 404);

      const bookmarks = collection.get('bookmarks');
      const currentBookmarkIndex = bookmarks.findIndex(bookmark => bookmark.id === seriesId);
      const currentBookmark = bookmarks[currentBookmarkIndex];
      ctx.assert(currentBookmarkIndex !== -1, 404, `Could not find bookmark with ID ${seriesId}`);

      const { lastReadAt } = ctx.request.body;

      ctx.assert(Number.isInteger(lastReadAt), 400, `Could not parse 'lastReadAt' timestamp`);

      const newBookmark = { ...currentBookmark, lastReadAt };
      const newBookmarks = utils.replaceItemAtIndex(
        bookmarks,
        currentBookmarkIndex,
        newBookmark,
      );
      collection.set('bookmarks', newBookmarks);

      await collection.save();

      ctx.body = newBookmark;
    },
  ),
);

app.use(
  route.get(
    '/series',
    async (ctx) => {
      const { url, siteId, seriesSlug } = ctx.request.query;

      const hasUrl = Boolean(url);

      let normalizedUrl = hasUrl
        ? url
        : poketo.constructUrl(siteId, seriesSlug);

      const start = Date.now();
      ctx.body = await poketo.getSeries(normalizedUrl);
      const diff = Date.now() - start;
      ctx.log.info({
        target: normalizedUrl,
        referrer: ctx.request.get('referer'),
        duration: diff
      }, 'Fetch series list');
    },
  ),
);

app.use(
  route.get(
    '/chapter',
    async (ctx) => {
      const { url, siteId, seriesSlug, chapterSlug } = ctx.request.query;

      const hasUrl = Boolean(url);

      let normalizedUrl = hasUrl
        ? url
        : poketo.constructUrl(siteId, seriesSlug, chapterSlug);

      const start = Date.now();
      ctx.body = await poketo.getChapter(normalizedUrl);
      const diff = Date.now() - start;
      ctx.log.info({
        target: normalizedUrl,
        referrer: ctx.request.get('referer'),
        duration: diff
      }, 'Fetch chapter');
    },
  )
);

/**
 * Server
 */

const PORT = process.env.PORT || 3001;

app.listen(PORT);
console.log(`> Listening on http://localhost:${PORT}`)
