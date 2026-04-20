/**
 * Variant identifier resolution and cohort-format helpers.
 *
 * Ports the OpenAI life-science plugin's `variant_resolution.py` (shared across
 * all 5 PheWAS skills) into TypeScript. Used by `phewas-mcp-server` and
 * `l2g-mapper-mcp-server`.
 */

export type GenomeBuild = "GRCh37" | "GRCh38";

export interface VariantCoord {
	chr: string;
	pos: number;
	ref: string | null;
	alt: string | null;
	canonical?: string;
}

export interface ResolvedVariant {
	input: { type: "rsid" | "grch37" | "grch38"; value: string };
	rsid: string | null;
	grch37: VariantCoord | null;
	grch38: VariantCoord | null;
	warnings: string[];
}

export interface ParsedVariant {
	chr: string;
	pos: number;
	ref: string;
	alt: string;
}

export class VariantResolutionError extends Error {
	code: string;
	warnings: string[];
	constructor(code: string, message: string, warnings: string[] = []) {
		super(message);
		this.name = "VariantResolutionError";
		this.code = code;
		this.warnings = warnings;
	}
}

const ENSEMBL_GRCH38 = "https://rest.ensembl.org";
const ENSEMBL_GRCH37 = "https://grch37.rest.ensembl.org";
const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT = "bio-mcp-variant-resolver/1.0";

const SEP_RE = /[-:_/\s]+/;
const CHR_RE = /^(?:chr)?([0-9]{1,2}|X|Y|M|MT)$/i;
const ALLELE_RE = /^[A-Za-z*]+$/;

/** "GRCh37" -> "grch37", everything else -> "grch38". */
export function buildKeyFor(build: GenomeBuild | "hg19"): "grch37" | "grch38" {
	return build === "GRCh37" || build === "hg19" ? "grch37" : "grch38";
}

function serverFor(build: GenomeBuild | "hg19"): string {
	return build === "GRCh37" || build === "hg19" ? ENSEMBL_GRCH37 : ENSEMBL_GRCH38;
}

function assemblyName(build: GenomeBuild | "hg19"): "GRCh37" | "GRCh38" {
	return build === "GRCh37" || build === "hg19" ? "GRCh37" : "GRCh38";
}

/** Parses a free-form variant string like `chr1-123-A-G`, `1:123_A/G`, etc. */
export function parseVariantString(value: string): ParsedVariant {
	const raw = value.trim();
	if (!raw) throw new Error("Variant string is empty.");

	const parts = raw.split(SEP_RE).filter(Boolean);
	if (parts.length !== 4) {
		throw new Error(
			"Invalid variant format. Expected chrom-pos-ref-alt with flexible separators.",
		);
	}

	const [chromRaw, posRaw, refRaw, altRaw] = parts;
	const chromMatch = CHR_RE.exec(chromRaw);
	if (!chromMatch) throw new Error(`Invalid chromosome: ${JSON.stringify(chromRaw)}`);
	let chrom = chromMatch[1].toUpperCase();
	if (chrom === "M") chrom = "MT";

	const pos = Number.parseInt(posRaw, 10);
	if (!Number.isFinite(pos) || `${pos}` !== posRaw) {
		throw new Error(`Invalid position: ${JSON.stringify(posRaw)}`);
	}
	if (pos <= 0) throw new Error("Position must be > 0.");

	const ref = refRaw.toUpperCase();
	const alt = altRaw.toUpperCase();
	if (!ALLELE_RE.test(ref)) throw new Error(`Invalid REF allele: ${JSON.stringify(refRaw)}`);
	if (!ALLELE_RE.test(alt)) throw new Error(`Invalid ALT allele: ${JSON.stringify(altRaw)}`);

	return { chr: chrom, pos, ref, alt };
}

/** Convenience wrapper exposed in the plan's API. */
export function parseVariant(input: string): ParsedVariant {
	return parseVariantString(input);
}

export function buildVariantRecord(
	chrom: string,
	pos: number,
	ref: string | null,
	alt: string | null,
): VariantCoord {
	const record: VariantCoord = { chr: chrom, pos, ref, alt };
	if (ref != null && alt != null) record.canonical = `${chrom}:${pos}-${ref}-${alt}`;
	return record;
}

async function getJson(
	url: string,
	{ timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			headers: { Accept: "application/json", "User-Agent": USER_AGENT },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${url}`);
		}
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

interface EnsemblMapping {
	assembly_name?: string;
	seq_region_name?: string;
	start?: number;
	allele_string?: string;
}

interface EnsemblVariation {
	mappings?: EnsemblMapping[];
}

interface EnsemblOverlapVariant {
	id?: string;
	alleles?: string[];
}

interface RsidLookupResult {
	chr: string;
	pos: number;
	ref: string | null;
	alts: string[];
}

interface PositionLookupResult {
	rsid: string;
	ref: string | null;
	alts: string[];
}

export interface ResolveOptions {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}

export async function lookupRsid(
	rsid: string,
	build: GenomeBuild = "GRCh38",
	opts: ResolveOptions = {},
): Promise<RsidLookupResult | null> {
	const server = serverFor(build);
	const asm = assemblyName(build);
	const url = `${server}/variation/human/${encodeURIComponent(rsid)}?content-type=application/json`;
	const data = (await getJson(url, opts)) as EnsemblVariation;
	const mappings = data?.mappings;
	if (!Array.isArray(mappings) || mappings.length === 0) return null;
	for (const mapping of mappings) {
		if (
			mapping?.assembly_name === asm &&
			mapping.seq_region_name &&
			typeof mapping.start === "number"
		) {
			const alleleString = typeof mapping.allele_string === "string" ? mapping.allele_string : "";
			const alleles = alleleString ? alleleString.split("/") : [];
			return {
				chr: String(mapping.seq_region_name),
				pos: Number(mapping.start),
				ref: alleles[0] ?? null,
				alts: alleles.length > 1 ? alleles.slice(1) : [],
			};
		}
	}
	return null;
}

export async function lookupPosition(
	chrom: string,
	pos: number,
	build: GenomeBuild = "GRCh38",
	opts: ResolveOptions = {},
): Promise<PositionLookupResult | null> {
	const server = serverFor(build);
	const url = `${server}/overlap/region/human/${chrom}:${pos}-${pos}?feature=variation;content-type=application/json`;
	const data = (await getJson(url, opts)) as EnsemblOverlapVariant[];
	if (!Array.isArray(data) || data.length === 0) return null;
	for (const variant of data) {
		if (typeof variant?.id === "string" && variant.id.startsWith("rs")) {
			const alleles = Array.isArray(variant.alleles) ? variant.alleles : [];
			return {
				rsid: variant.id,
				ref: alleles[0] ?? null,
				alts: alleles.length > 1 ? alleles.slice(1) : [],
			};
		}
	}
	return null;
}

interface BothBuildsResult {
	rsid: string;
	grch38: { chr: string | null; pos: number | null };
	grch37: { chr: string | null; pos: number | null };
	ref: string | null;
	alts: string[];
	warnings: string[];
}

export async function resolveRsidBothBuilds(
	rsid: string,
	opts: ResolveOptions = {},
): Promise<BothBuildsResult> {
	const warnings: string[] = [];
	let g38: RsidLookupResult | null = null;
	let g37: RsidLookupResult | null = null;
	try {
		g38 = await lookupRsid(rsid, "GRCh38", opts);
	} catch (err) {
		warnings.push(`GRCh38 lookup failed: ${(err as Error).message}`);
	}
	try {
		g37 = await lookupRsid(rsid, "GRCh37", opts);
	} catch (err) {
		warnings.push(`GRCh37 lookup failed: ${(err as Error).message}`);
	}
	const ref = (g38?.ref ?? null) || (g37?.ref ?? null);
	const alts = (g38?.alts && g38.alts.length > 0 ? g38.alts : g37?.alts) ?? [];
	return {
		rsid,
		grch38: { chr: g38?.chr ?? null, pos: g38?.pos ?? null },
		grch37: { chr: g37?.chr ?? null, pos: g37?.pos ?? null },
		ref,
		alts,
		warnings,
	};
}

/** Resolves a variant given as an rsID. Returns coords for both builds. */
export async function resolveRsid(
	rsid: string,
	opts: ResolveOptions = {},
): Promise<ResolvedVariant> {
	if (!rsid.startsWith("rs")) throw new Error("rsid must start with 'rs'.");
	const both = await resolveRsidBothBuilds(rsid, opts);
	const ref = both.ref ?? null;
	const alt = both.alts[0] ?? null;
	const g37 =
		both.grch37.chr && both.grch37.pos != null
			? buildVariantRecord(both.grch37.chr, both.grch37.pos, ref, alt)
			: null;
	const g38 =
		both.grch38.chr && both.grch38.pos != null
			? buildVariantRecord(both.grch38.chr, both.grch38.pos, ref, alt)
			: null;
	return {
		input: { type: "rsid", value: rsid },
		rsid,
		grch37: g37,
		grch38: g38,
		warnings: both.warnings,
	};
}

/**
 * Lift a variant between builds via Ensembl: position lookup on the source
 * build to find an rsID, then rsID lookup on the target build.
 */
export async function liftover(
	variant: ParsedVariant,
	fromBuild: GenomeBuild,
	toBuild: GenomeBuild,
	opts: ResolveOptions = {},
): Promise<VariantCoord> {
	if (fromBuild === toBuild) {
		return buildVariantRecord(variant.chr, variant.pos, variant.ref, variant.alt);
	}
	const positionResult = await lookupPosition(variant.chr, variant.pos, fromBuild, opts);
	if (!positionResult) {
		throw new VariantResolutionError(
			"not_found",
			`No rsID found at ${variant.chr}:${variant.pos} on ${fromBuild}.`,
		);
	}
	const targetCoord = await lookupRsid(positionResult.rsid, toBuild, opts);
	if (!targetCoord) {
		throw new VariantResolutionError(
			"not_found",
			`rsID ${positionResult.rsid} not mappable to ${toBuild}.`,
		);
	}
	const ref = targetCoord.ref ?? variant.ref ?? null;
	const alts = targetCoord.alts ?? [];
	const alt = alts.includes(variant.alt) ? variant.alt : alts[0] ?? variant.alt;
	return buildVariantRecord(targetCoord.chr, targetCoord.pos, ref, alt);
}

export async function resolveVariant(
	inputType: "rsid" | "grch37" | "grch38",
	inputValue: string,
	opts: ResolveOptions = {},
): Promise<ResolvedVariant> {
	if (inputType === "rsid") return resolveRsid(inputValue, opts);

	const build: GenomeBuild = inputType === "grch37" ? "GRCh37" : "GRCh38";
	const parsed = parseVariantString(inputValue);
	const otherBuild: GenomeBuild = build === "GRCh37" ? "GRCh38" : "GRCh37";
	const warnings: string[] = [];

	const positionResult = await lookupPosition(parsed.chr, parsed.pos, build, opts);
	if (!positionResult) {
		throw new VariantResolutionError(
			"not_found",
			`No rsID found at ${parsed.chr}:${parsed.pos} on ${build} via Ensembl overlap endpoint.`,
		);
	}

	const ref = positionResult.ref ?? parsed.ref;
	const alts = positionResult.alts ?? [];
	if (positionResult.ref && parsed.ref !== positionResult.ref) {
		warnings.push(`Input ref ${parsed.ref} != resolved ref ${positionResult.ref}; keeping resolved ref.`);
	}
	let alt: string;
	if (alts.includes(parsed.alt)) {
		alt = parsed.alt;
	} else if (alts.length > 0) {
		alt = alts[0];
		warnings.push(`Input alt ${parsed.alt} not among resolved alts ${JSON.stringify(alts)}; using ${alt}.`);
	} else {
		alt = parsed.alt;
	}

	let other: RsidLookupResult | null = null;
	try {
		other = await lookupRsid(positionResult.rsid, otherBuild, opts);
	} catch (err) {
		warnings.push(`Other-build lookup failed: ${(err as Error).message}`);
	}

	const sameBuild: VariantCoord = buildVariantRecord(parsed.chr, parsed.pos, ref, alt);
	const otherBuildCoord: VariantCoord | null = other
		? buildVariantRecord(other.chr, other.pos, ref, alt)
		: null;

	return {
		input: { type: inputType, value: inputValue },
		rsid: positionResult.rsid,
		grch37: build === "GRCh37" ? sameBuild : otherBuildCoord,
		grch38: build === "GRCh38" ? sameBuild : otherBuildCoord,
		warnings,
	};
}

/**
 * Cohort identifiers supported by phewas-mcp-server. The format string is the
 * URL path-segment expected by the cohort's `/api/variant/{...}` endpoint.
 *
 * Notes:
 *   - finngen / ukb-topmed / tpmi expect GRCh38 coords
 *   - bbj expects GRCh37 coords
 *   - genebass uses gene-level burden (separate path; see formatGenebass)
 *
 * All cohorts use the canonical `chrom:pos-ref-alt` format string.
 */
export type Cohort = "finngen" | "ukb-topmed" | "bbj" | "tpmi";

export const COHORT_BUILD: Record<Cohort, GenomeBuild> = {
	finngen: "GRCh38",
	"ukb-topmed": "GRCh38",
	bbj: "GRCh37",
	tpmi: "GRCh38",
};

/**
 * Produce the cohort-specific URL path-segment for `/api/variant/{...}`.
 * The caller is responsible for liftover if the input variant is in a
 * different build than the cohort expects (use `liftover()` first or
 * `resolveVariant()` and pick the right `grch37`/`grch38` field).
 */
export function formatForCohort(variant: VariantCoord, _cohort: Cohort): string {
	if (variant.canonical) return variant.canonical;
	if (variant.ref == null || variant.alt == null) {
		throw new Error("formatForCohort requires variant.ref and variant.alt");
	}
	return `${variant.chr}:${variant.pos}-${variant.ref}-${variant.alt}`;
}
