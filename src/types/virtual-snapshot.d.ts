// Provided by the vite plugin in vite.config.ts: the embedded data snapshot
// (base64 of snapshot/bundle.json.gz, built by scripts/snapshot-bundle.mjs).
declare module 'virtual:rdb-snapshot' {
  const gzBase64: string;
  export default gzBase64;
}
