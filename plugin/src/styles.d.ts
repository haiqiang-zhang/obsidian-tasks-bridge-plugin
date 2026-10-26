declare module "*.css?raw" {
  const css: string;
  // biome-ignore lint/style/noDefaultExport: Vite raw assets expose a default string export.
  export default css;
}
