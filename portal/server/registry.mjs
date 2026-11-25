import { readFile } from 'node:fs/promises';

export function validateApps(input) {
  if (!Array.isArray(input) || input.length > 50) {
    throw new Error('The app registry must be an array of at most 50 applications.');
  }
  const ids = new Set();
  const paths = new Set();
  return input.map((application) => {
    if (!application || !/^[a-z][a-z0-9-]{0,39}$/.test(application.id)) {
      throw new Error('Each application needs a valid, stable id.');
    }
    for (const field of ['name', 'description', 'category', 'runtime', 'source']) {
      if (typeof application[field] !== 'string' || !application[field].trim() || application[field].length > 240) {
        throw new Error(`Invalid ${field} for ${application.id}.`);
      }
    }
    if (!/^\/[a-z][a-z0-9-]*\/$/.test(application.path)
      || ['/api/', '/assets/'].includes(application.path)) {
      throw new Error(`Application ${application.id} must use its own same-origin path prefix.`);
    }
    if (ids.has(application.id) || paths.has(application.path)) {
      throw new Error('Application ids and path prefixes must be unique.');
    }
    ids.add(application.id);
    paths.add(application.path);
    if (application.apiPath != null && (!application.apiPath.startsWith(application.path)
      || application.apiPath.includes('..') || /[?#\\]/.test(application.apiPath))) {
      throw new Error(`The API for ${application.id} must be inside its application path.`);
    }
    if (application.healthUrl) {
      const healthUrl = new URL(application.healthUrl);
      if (!['http:', 'https:'].includes(healthUrl.protocol) || healthUrl.username || healthUrl.password) {
        throw new Error(`Invalid health URL for ${application.id}.`);
      }
    }
    return {
      id: application.id,
      name: application.name,
      description: application.description,
      category: application.category,
      path: application.path,
      apiPath: application.apiPath ?? null,
      healthUrl: application.healthUrl ?? null,
      icon: ['shopping-basket', 'network', 'app-window', 'music', 'folder', 'book-open'].includes(application.icon)
        ? application.icon : 'app-window',
      color: ['green', 'blue', 'pink', 'amber'].includes(application.color) ? application.color : 'green',
      runtime: application.runtime,
      source: application.source,
    };
  });
}

export async function loadApps(file, environment = process.env) {
  const apps = validateApps(JSON.parse(await readFile(file, 'utf8')));
  return validateApps(apps.map((application) => ({
    ...application,
    healthUrl: environment[`${application.id.toUpperCase().replaceAll('-', '_')}_HEALTH_URL`] ?? application.healthUrl,
  })));
}

export function publicApp({ healthUrl, ...application }) {
  return application;
}