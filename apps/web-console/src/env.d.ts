/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM_API_URL?: string;
  readonly VITE_QUERY_API_URL?: string;
  readonly VITE_INGESTION_PROBE_URL?: string;
  readonly VITE_SCHEDULER_PROBE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
