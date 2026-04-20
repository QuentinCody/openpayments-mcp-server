# Cross-server upstream adapters

Cross-server upstream adapters live here. Promoted from per-server
`lib/api-adapter.ts` by Phase 3C of the life-science expansion plan
(`docs/plans/2026-04-16-life-science-expansion.md`).

The L2G mapper is the first consumer; other servers should import from here
going forward when they need to call the same upstream APIs (Ensembl,
OpenTargets, GTEx, Genebass, ClinVar, gnomAD, HPA, GWAS Catalog, EFO/OLS4).
