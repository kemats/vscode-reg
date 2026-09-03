export interface HiveLocation {
  path: string;
  key: string;
  value?: string;
}

export function createHiveLocationUri(scheme: string, extensionId: string, location: HiveLocation): string {
  const query = new URLSearchParams({ path: location.path, key: location.key });
  if (location.value !== undefined) { query.set('value', location.value); }
  return `${scheme}://${extensionId}/open?${query.toString()}`;
}

export function parseHiveLocationUri(path: string, query: string): HiveLocation | undefined {
  if (path !== '/open') { return undefined; }
  const parameters = new URLSearchParams(query);
  const hivePath = parameters.get('path');
  if (!hivePath) { return undefined; }
  const location: HiveLocation = { path: hivePath, key: parameters.get('key') ?? '' };
  if (parameters.has('value')) { location.value = parameters.get('value') ?? ''; }
  return location;
}