// geist declares its fonts in ambient `declare module` blocks inside
// font.d.ts, and nothing pulls that file into the program: the package's export
// map points `geist/font/mono` at dist/mono.d.ts, which re-exports `../font` —
// a file whose declarations all sit inside `declare module`, so it has no
// top-level exports to re-export.
//
// It has always resolved locally off a warm tsconfig.tsbuildinfo, and fails the
// moment the incremental cache is cold, which is every CI run. Declaring the
// one member the app imports keeps `tsc --noEmit` honest on a clean checkout.
declare module 'geist/font/mono' {
  export const GeistMono: import('next/dist/compiled/@next/font').NextFontWithVariable;
}
