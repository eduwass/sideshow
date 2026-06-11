// wrangler bundles .html and .md imports as text (see rules in wrangler.jsonc)
declare module "*.html" {
  const text: string;
  export default text;
}

declare module "*.md" {
  const text: string;
  export default text;
}
