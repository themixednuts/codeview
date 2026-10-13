import { describe, expect, test } from "vite-plus/test";
import { firstDocParagraph, plainDocSummary, stripInlineMarkdown } from "./doc-summary.js";

describe("firstDocParagraph", () => {
  test("skips a leading heading and badges", () => {
    const docs = [
      "# Serde",
      "[![Build](https://img.shields.io/x.svg)](https://ci) [![Docs](https://d.svg)](https://docs)",
      "Serde is a framework for *ser*ializing and *de*serializing Rust data structures.",
    ].join("\n\n");
    expect(firstDocParagraph(docs)).toBe(
      "Serde is a framework for *ser*ializing and *de*serializing Rust data structures.",
    );
  });

  test("skips fenced code that contains blank lines", () => {
    const docs = "```rust\nlet a = 1;\n\nlet b = 2;\n```\n\nAfter the example.";
    expect(firstDocParagraph(docs)).toBe("After the example.");
  });

  test("returns null for empty or heading-only docs", () => {
    expect(firstDocParagraph(undefined)).toBeNull();
    expect(firstDocParagraph("# Title")).toBeNull();
  });
});

describe("stripInlineMarkdown", () => {
  test("keeps visible text only", () => {
    expect(
      stripInlineMarkdown(
        "A **data format** that can [`deserialize`](crate::de) any `T` using [Visitor].",
      ),
    ).toBe("A data format that can deserialize any T using Visitor.");
  });

  test("leaves snake_case identifiers alone", () => {
    expect(stripInlineMarkdown("Calls deserialize_any and is_human_readable.")).toBe(
      "Calls deserialize_any and is_human_readable.",
    );
  });
});

describe("plainDocSummary", () => {
  test("truncates long summaries", () => {
    const summary = plainDocSummary("word ".repeat(100), 20);
    expect(summary?.length).toBe(20);
    expect(summary?.endsWith("…")).toBe(true);
  });
});
