declare module "@shikijs/langs/*" {
  const lang: any;
  export default lang;
}

declare module "@shikijs/themes/*" {
  const theme: {
    colors?: Record<string, string>;
    tokenColors?: Array<{
      settings: { foreground?: string };
    }>;
  };
  export default theme;
}
