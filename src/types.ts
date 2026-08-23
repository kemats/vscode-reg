export interface HiveValue {
  name: string;
  rawName: string;
  type: string;
  typeCode: number;
  size: number;
  data: string;
}

export interface HiveKey {
  name: string;
  lastWrite: string | null;
  subkeyCount: number;
}

export interface KeyListing {
  path: string;
  lastWrite: string | null;
  subkeyCount: number;
  subkeyOffset: number;
  hasMoreSubkeys: boolean;
  subkeys: HiveKey[];
  values: HiveValue[];
}

export interface SearchResult {
  kind: 'key' | 'value';
  key: string;
  value?: HiveValue;
}

export interface SearchResponse {
  query: string;
  indexedRecords: number;
  indexBuilt: boolean;
  results: SearchResult[];
  elapsedMs: number;
}

export interface HiveValueData {
  name: string;
  type: string;
  typeCode: number;
  size: number;
  bytes: number[];
  activeCodePage: number;
  activeCodePageText: string;
}
