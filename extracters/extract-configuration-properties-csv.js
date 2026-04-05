/**
 * Extract configuration property blocks from
 * https://udocs.unblu.com/latest-internal/reference/configuration-properties.html
 * and download as CSV.
 */
(function extractPropertiesToCsv() {
  const TYPE_ALLOWED_VALUES_SEPARATOR = /\s+with allowed values:\s+/i;

  function cleanText(value) {
    return (value || "").replace(/\s+/g, " ").trim();
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

  function getFieldMap(propertyBlock) {
    const map = {
      type: "",
      allowedValues: "",
      default: "",
      allowedScopes: "",
      visibility: "",
      editableBy: ""
    };

    const topItems = propertyBlock.querySelectorAll(":scope > .ulist.none > ul.none > li");

    topItems.forEach((li) => {
      const labelNode = li.querySelector("p > strong");
      if (!labelNode) return;

      const label = cleanText(labelNode.textContent).replace(/:$/, "").toLowerCase();

      let text = cleanText(li.textContent)
        .replace(new RegExp(`^${labelNode.textContent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`, "i"), "")
        .trim();

      if (label === "type") {
        const nestedValues = Array.from(li.querySelectorAll(":scope .ulist li p code, :scope .ulist li code"))
          .map((node) => cleanText(node.textContent))
          .filter(Boolean);

        if (nestedValues.length > 0 && !TYPE_ALLOWED_VALUES_SEPARATOR.test(text)) {
          text = `${text} with allowed values: ${nestedValues.join(", ")}`.trim();
        }

        const splitType = splitTypeAndAllowedValues(text);
        map.type = splitType.type;
        map.allowedValues = splitType.allowedValues;
        return;
      }

      if (label === "default") {
        map.default = text;
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

  function splitTypeAndAllowedValues(typeText) {
    const value = cleanText(typeText);
    if (!TYPE_ALLOWED_VALUES_SEPARATOR.test(value)) {
      return {
        type: normalizeTypeLabel(value),
        allowedValues: ""
      };
    }

    const parts = value.split(TYPE_ALLOWED_VALUES_SEPARATOR);
    const [rawType, ...allowedValuesParts] = parts;
    return {
      type: normalizeTypeLabel(cleanText(rawType)),
      allowedValues: cleanText(allowedValuesParts.join(", "))
    };
  }

  function normalizeTypeLabel(typeValue) {
    return typeValue === "List of string" ? "List of strings" : typeValue;
  }

  function getDescription(propertyBlock) {
    const paragraphs = propertyBlock.querySelectorAll(":scope > .paragraph > p");
    if (paragraphs.length < 2) return "";
    const parts = Array.from(paragraphs)
      .slice(1)
      .map((p) => cleanText(p.textContent))
      .filter(Boolean);
    return cleanText(parts.join(" "));
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
        allowedValues: fields.allowedValues,
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
    "allowed values",
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
        row.allowedValues,
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
  link.download = "configuration-properties.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(url);
  console.log(`Export complete: ${rows.length} rows`);
})();