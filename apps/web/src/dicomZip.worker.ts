import { unzipSync } from 'fflate';

type ZipEntryPayload = {
  name: string;
  buffer: ArrayBuffer;
};

type ZipWorkerRequest = {
  type: 'unzip-dicom-zip';
  buffer: ArrayBuffer;
};

type ZipWorkerResponse = {
  type: 'ok' | 'error';
  entries?: ZipEntryPayload[];
  warning?: string | null;
  error?: string;
};

type WorkerScope = {
  onmessage: ((event: MessageEvent<ZipWorkerRequest>) => void) | null;
  postMessage: (message: ZipWorkerResponse, transfer?: Transferable[]) => void;
};

const workerScope = self as unknown as WorkerScope;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isLikelyDicom(name: string, bytes: Uint8Array): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.dcm') || lower.endsWith('.dicom')) return true;
  if (bytes.byteLength > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d) {
    return true;
  }
  return !lower.endsWith('/') && bytes.byteLength > 1024;
}

workerScope.onmessage = (event: MessageEvent<ZipWorkerRequest>) => {
  try {
    if (event.data?.type !== 'unzip-dicom-zip') {
      throw new Error('unsupported_zip_worker_message');
    }
    const archive = unzipSync(new Uint8Array(event.data.buffer));
    const candidates: ZipEntryPayload[] = [];
    const fallback: ZipEntryPayload[] = [];

    for (const [name, bytes] of Object.entries(archive)) {
      if (!bytes || !bytes.byteLength) continue;
      const entry: ZipEntryPayload = {
        name,
        buffer: toArrayBuffer(bytes),
      };
      if (isLikelyDicom(name, bytes)) candidates.push(entry);
      else fallback.push(entry);
    }

    const entries = (candidates.length ? candidates : fallback)
      .filter((entry) => !entry.name.endsWith('/'))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

    if (!entries.length) {
      throw new Error('no_dicom_like_entries_found_in_zip');
    }

    const transfer = entries.map((entry) => entry.buffer);
    const response: ZipWorkerResponse = {
      type: 'ok',
      entries,
      warning: candidates.length ? null : 'zip_entries_were_not_identified_as_explicit_dicom_files; using binary fallback ordering',
    };
    workerScope.postMessage(response, transfer);
  } catch (error) {
    const response: ZipWorkerResponse = {
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};
