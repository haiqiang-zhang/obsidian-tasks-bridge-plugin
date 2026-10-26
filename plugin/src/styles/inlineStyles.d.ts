declare module "*.scss?inline" {
  const css: string;
  // biome-ignore lint/style/noDefaultExport: Vite's inline stylesheet modules expose a default string.
  export default css;
}
