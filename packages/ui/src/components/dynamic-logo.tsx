// The logo used to load on the client only, because the theme it depends on is
// unknown during a server render. There is no server render now, so this is
// the logo itself, kept at this path for the pages that import it.
export { default as Logo } from './logo';
