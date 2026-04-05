/**
 * Extract configuration property blocks from
 * https://udocs.unblu.com/latest-internal/reference/text-properties.html
 * and download as CSV.
 *
 * Variant for pages where:
 * - properties are in div.sect1 > .sectionbody > div.sect2
 * - "Default" label is in metadata list
 * - default value is often in the next .listingblock > .content > pre
 *
 */
(function extractPropertiesToCsvListingDefault() {
  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
  }

  function cleanPreText(value) {
    return String(value ?? "").replace(/\r\n/g, "\n").trim();
  }

  function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function getDirectSect2Blocks(categoryBlock) {
    const sectionBody = categoryBlock.querySelector(":scope > .sectionbody");
    if (!sectionBody) return [];
    return Array.from(sectionBody.querySelectorAll(":scope > .sect2"));
  }

  function getDefaultFromInlineLi(defaultLi, defaultLabelText) {
    if (!defaultLi) return "";
    const escapedLabel = defaultLabelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return cleanText(defaultLi.textContent).replace(new RegExp(`^${escapedLabel}\\s*:\\s*`, "i"), "").trim();
  }

  function getDefaultFromListingBlock(propertyBlock) {
    const pre = propertyBlock.querySelector(":scope > .listingblock > .content > pre");
    return pre ? cleanPreText(pre.textContent) : "";
  }

  function getDefaultValue(propertyBlock, defaultLi, defaultLabelText) {
    const inlineDefault = getDefaultFromInlineLi(defaultLi, defaultLabelText);
    if (inlineDefault) return inlineDefault;
    return getDefaultFromListingBlock(propertyBlock);
  }

  function getFieldMap(propertyBlock) {
    const map = {
      type: "",
      default: "",
      allowedScopes: "",
      visibility: "",
      editableBy: ""
    };

    const topItems = propertyBlock.querySelectorAll(":scope > .ulist.none > ul.none > li");

    topItems.forEach((li) => {
      const labelNode = li.querySelector("p > strong");
      if (!labelNode) return;

      const rawLabelText = cleanText(labelNode.textContent);
      const label = rawLabelText.replace(/:$/, "").toLowerCase();

      let text = cleanText(li.textContent)
        .replace(new RegExp(`^${rawLabelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i"), "")
        .trim();

      if (label === "type") {
        const nestedValues = Array.from(li.querySelectorAll(":scope .ulist li p code, :scope .ulist li code"))
          .map((node) => cleanText(node.textContent))
          .filter(Boolean);

        if (nestedValues.length > 0) {
          text = `${text} ${nestedValues.join(", ")}`.trim();
        }
        map.type = text;
        return;
      }

      if (label === "default") {
        map.default = getDefaultValue(propertyBlock, li, rawLabelText);
        return;
      }

      if (label === "allowed scopes") {
        map.allowedScopes = text;
        return;
      }

      if (label === "visibility") {
        map.visibility = text;
        return;
      }

      if (label === "editable by") {
        map.editableBy = text;
      }
    });

    return map;
  }

  function getDescription(propertyBlock) {
    const paragraphs = propertyBlock.querySelectorAll(":scope > .paragraph > p");
    if (paragraphs.length < 2) return "";
    const parts = Array.from(paragraphs)
      .slice(1)
      .map((p) => cleanText(p.textContent))
      .filter(Boolean);
    return parts.join(" - ");
  }

  const rows = [];
  const categoryBlocks = document.querySelectorAll("div.sect1");

  categoryBlocks.forEach((categoryBlock) => {
    const category = cleanText(categoryBlock.querySelector(":scope > h2")?.textContent);
    const properties = getDirectSect2Blocks(categoryBlock);

    properties.forEach((propertyBlock) => {
      const propertyTitle = cleanText(propertyBlock.querySelector(":scope > h3")?.textContent);
      const propertyName = cleanText(
        propertyBlock.querySelector(":scope > .paragraph code.code__key, :scope > .paragraph code")?.textContent
      );

      const fields = getFieldMap(propertyBlock);
      const description = getDescription(propertyBlock);

      rows.push({
        category,
        propertyTitle,
        property: propertyName,
        defaultValue: fields.default,
        type: fields.type,
        allowedScopes: fields.allowedScopes,
        visibility: fields.visibility,
        editableBy: fields.editableBy,
        description
      });
    });
  });

  const headers = [
    "category",
    "property title",
    "property",
    "default value",
    "type",
    "allowed scopes",
    "visibility",
    "editable by",
    "description"
  ];

  const csvLines = [
    headers.join(","),
    ...rows.map((row) =>
      [
        row.category,
        row.propertyTitle,
        row.property,
        row.defaultValue,
        row.type,
        row.allowedScopes,
        row.visibility,
        row.editableBy,
        row.description
      ]
        .map(csvEscape)
        .join(",")
    )
  ];

  const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = "text-properties.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
  console.log(`Export complete: ${rows.length} rows`);
})();