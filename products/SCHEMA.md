# Product dataset schema (one JSON file per category: products/data/<id>.json)

{
  "id": "health",                       // file id
  "title": "Health Insurance",
  "asOf": "Oct 2026",                   // when the figures were checked
  "intro": "One sentence on what this category is and what matters most when choosing.",
  "newsQuery": "health insurance India", // Google News search for category news
  "sources": ["IRDAI Annual Report 2024-25", "insurer websites (Oct 2026)"],
  "groups": [ {"id":"claims","label":"Claims"}, {"id":"cost","label":"Cost"} ],
  "params": [
    {"k":"csr","label":"Claim settlement ratio","fmt":"pct","better":"high","w":3,"g":"claims","tip":"Share of claims paid in FY2024-25 (IRDAI)."}
  ],
  "items": [
    {"id":"star-health","name":"Star Health Comprehensive","provider":"Star Health & Allied Insurance","kind":"Standalone health insurer",
     "tags":["family floater","individual"],
     "v":{"csr":82.3, ...},             // keys from params; use null when unknown. NEVER invent numbers.
     "pros":["..."], "cons":["..."],    // 2-4 each, short, factual
     "best":"Who it suits, one line",
     "url":"https://official-product-page",
     "news":"Star Health insurance"     // Google News query for this item
    }
  ]
}

fmt values: "pct" (number, %), "num" (plain number), "inr" (rupees, number), "x" (multiplier), "years", "days", "text" (string), "yes" (true/false).
better: "high" | "low" | null (not scored). w: weight 1-3 for scoring (only numeric/yes params with better set).
Every number must come from a real, checkable source; leave null if not found. Keep 10-30 items per file.
