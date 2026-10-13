// Test helper: loads the committed mock JSON from disk (tests run under Node).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MockFile } from './rebase';
import { MockDataSource, type MockOptions } from './MockDataSource';

let cached: MockFile | null = null;
export function mockFile(): MockFile {
  if (!cached) cached = JSON.parse(readFileSync(resolve(__dirname, '../../../../db/mock_data.json'), 'utf8')) as MockFile;
  return cached;
}
export function newMock(opts: MockOptions = {}): MockDataSource {
  return new MockDataSource({ today: '2026-10-12', file: structuredClone(mockFile()), ...opts });
}
