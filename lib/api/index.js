import MangaUpdatesAdapter from './adapters/manga-updates';
import MangakakalotAdapter from './adapters/mangakakalot';
import MerakiScansAdapter from './adapters/meraki-scans';
import HelveticaScansAdapter from './adapters/helvetica-scans';

const adapters = [
  MangaUpdatesAdapter,
  MangakakalotAdapter,
  MerakiScansAdapter,
  HelveticaScansAdapter,
];

function getSupportedAdapter(url) {
  const supported = adapters.filter(adapter => adapter.supportsUrl(url));
  if (supported.length < 1) {
    throw new Error(`No adapter supports '${url}'`);
  }
  return supported[0];
}

export default {
  async getSeriesMetadata(url, seriesId) {
    const site = getSupportedAdapter(url);
    const series = await site.getSeriesMetadata(seriesId);

    return { ...series, supportsReading: site.supportsReading() };
  },

  async getSeriesChapter(url, seriesId, chapterId) {
    const site = getSupportedAdapter(url);
    return await site.getSeriesChapter(seriesId, chapterId);
  },
};