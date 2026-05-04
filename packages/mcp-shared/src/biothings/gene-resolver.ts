/**
 * Typed gene resolution contract.
 *
 * Mirrors the call surface of the biothings-mcp-server's
 * `biothings_gene_resolve` tool so that any MCP server (depmap, peddep,
 * future bulk-ingest servers) can resolve gene symbols to authoritative
 * cross-references with the same shape biothings already exposes.
 *
 * The default implementation calls MyGene.info directly with the same
 * scopes/fields biothings uses internally — no cross-server MCP RPC.
 */

export interface GeneResolution {
    readonly query: string;
    readonly found: boolean;
    readonly entrezgene?: number;
    readonly symbol?: string;
    readonly ensembl_gene?: string;
    readonly ensembl_protein?: readonly string[];
    readonly uniprot?: string;
    readonly hgnc?: string;
    readonly aliases?: readonly string[];
}

export interface GeneResolverOptions {
    /** NCBI taxonomy filter (default: "human"). Pass null for no filter. */
    readonly species?: string | null;
    /** Optional abort signal for fetch cancellation. */
    readonly signal?: AbortSignal;
}

export type GeneResolver = (
    identifiers: readonly string[],
    options?: GeneResolverOptions,
) => Promise<ReadonlyMap<string, GeneResolution>>;

export interface CreateMyGeneResolverOptions {
    /** Optional fetch implementation; defaults to global fetch. */
    readonly fetch?: typeof fetch;
    /** User-Agent header sent with every request. */
    readonly userAgent?: string;
    /** Override the MyGene.info base URL (test injection). */
    readonly baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://mygene.info/v3";
const DEFAULT_USER_AGENT = "bio-mcp/gene-resolver";
const SCOPES = "symbol,alias,entrezgene,ensembl.gene";
const FIELDS =
    "entrezgene,ensembl.gene,ensembl.protein,uniprot.Swiss-Prot,HGNC,symbol,alias";
const MAX_BATCH_SIZE = 1000;

interface MyGeneHit {
    readonly query: string;
    readonly notfound?: boolean;
    readonly entrezgene?: number;
    readonly symbol?: string;
    readonly HGNC?: string;
    readonly ensembl?:
        | { readonly gene?: string; readonly protein?: string | readonly string[] }
        | ReadonlyArray<{
              readonly gene?: string;
              readonly protein?: string | readonly string[];
          }>;
    readonly uniprot?: {
        readonly "Swiss-Prot"?: string | readonly string[];
    };
    readonly alias?: string | readonly string[];
}

function chunk<T>(arr: readonly T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        out.push(arr.slice(i, i + size));
    }
    return out;
}

function extractEnsemblGene(hit: MyGeneHit): string | undefined {
    const e = hit.ensembl;
    if (!e) return undefined;
    if (Array.isArray(e)) return e[0]?.gene;
    return (e as { gene?: string }).gene;
}

function extractEnsemblProteins(hit: MyGeneHit): string[] | undefined {
    const e = hit.ensembl;
    if (!e) return undefined;
    const items = Array.isArray(e) ? e : [e];
    const proteins: string[] = [];
    for (const item of items) {
        const p = (item as { protein?: string | readonly string[] }).protein;
        if (Array.isArray(p)) proteins.push(...p);
        else if (typeof p === "string") proteins.push(p);
    }
    return proteins.length > 0 ? proteins : undefined;
}

function extractUniprot(hit: MyGeneHit): string | undefined {
    const sp = hit.uniprot?.["Swiss-Prot"];
    if (!sp) return undefined;
    return typeof sp === "string" ? sp : sp[0];
}

function extractAliases(hit: MyGeneHit): readonly string[] | undefined {
    const a = hit.alias;
    if (!a) return undefined;
    return typeof a === "string" ? [a] : a;
}

function parseHit(hit: MyGeneHit): GeneResolution {
    if (hit.notfound) {
        return { query: hit.query, found: false };
    }
    return {
        query: hit.query,
        found: true,
        entrezgene: hit.entrezgene,
        symbol: hit.symbol,
        ensembl_gene: extractEnsemblGene(hit),
        ensembl_protein: extractEnsemblProteins(hit),
        uniprot: extractUniprot(hit),
        hgnc: hit.HGNC,
        aliases: extractAliases(hit),
    };
}

/**
 * Build a {@link GeneResolver} backed by MyGene.info.
 * Default base URL: https://mygene.info/v3
 */
export function createMyGeneResolver(
    options: CreateMyGeneResolverOptions = {},
): GeneResolver {
    const fetchImpl = options.fetch ?? fetch;
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;

    return async function resolve(identifiers, opts) {
        const out = new Map<string, GeneResolution>();
        if (identifiers.length === 0) return out;

        const species = opts?.species === undefined ? "human" : opts.species;

        for (const batch of chunk(identifiers, MAX_BATCH_SIZE)) {
            const params = new URLSearchParams();
            params.set("q", batch.join(","));
            params.set("scopes", SCOPES);
            params.set("fields", FIELDS);
            if (species !== null) params.set("species", species);

            const response = await fetchImpl(`${baseUrl}/query`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    "user-agent": userAgent,
                },
                body: params.toString(),
                signal: opts?.signal,
            });

            if (!response.ok) {
                const body = await response.text().catch(() => response.statusText);
                throw new Error(
                    `MyGene.info query failed: HTTP ${response.status} — ${body.slice(0, 200)}`,
                );
            }

            const data = (await response.json()) as MyGeneHit[];
            if (!Array.isArray(data)) continue;

            for (const hit of data) {
                out.set(hit.query, parseHit(hit));
            }
        }

        return out;
    };
}
