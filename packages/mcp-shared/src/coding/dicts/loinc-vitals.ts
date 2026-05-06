/**
 * LOINC vital-signs and common-anthropometrics subset.
 *
 * Includes only the LOINC codes referenced by the US Core Vital Signs profile
 * (https://hl7.org/fhir/us/core/StructureDefinition-us-core-vital-signs.html),
 * plus a handful of widely-used anthropometric codes. This is a tiny curated
 * subset — for a full LOINC dictionary, callers should register their own
 * dict via `registerCodingDict()`.
 *
 * Display strings are abbreviated common forms, not the LOINC LONG_COMMON_NAME
 * (which often includes redundant "in <body site>" modifiers). They are
 * suitable for SQL `*_display` columns and human-readable rendering.
 *
 * ────────────────────────────────────────────────────────────────────────
 * LOINC ATTRIBUTION
 *
 * This file includes content from LOINC® which is copyright © 1995-present
 * Regenstrief Institute, Inc. and the LOINC Committee. Content used under the
 * LOINC license at no cost. See: https://loinc.org/terms-of-use/
 *
 * The codes themselves are widely cited in public US health regulations
 * (ONC Cures Act, US Core IG) and are reproduced here in a curated subset
 * solely for the purpose of producing human-readable display strings when an
 * upstream payer/EHR omits `coding.display`. No part of this file constitutes
 * the full LOINC distribution.
 * ────────────────────────────────────────────────────────────────────────
 */

import { CLINICAL_SYSTEMS } from "../code-systems";

/** LOINC vital-signs subset (US Core Vital Signs). */
export const LOINC_VITALS_DICT: Readonly<Record<string, string>> = Object.freeze({
	"8302-2": "Body height",
	"8306-3": "Body height (lying)",
	"3137-7": "Body height (measured)",
	"3138-5": "Body height (stated)",
	"8287-5": "Head circumference",
	"9843-4": "Head circumference (Occipital-frontal)",
	"29463-7": "Body weight",
	"3141-9": "Body weight (measured)",
	"3142-7": "Body weight (stated)",
	"8348-5": "Usual body weight",
	"39156-5": "Body mass index (BMI)",
	"77606-2": "BMI percentile",
	"8867-4": "Heart rate",
	"8889-8": "Heart rate (palpation)",
	"9279-1": "Respiratory rate",
	"8310-5": "Body temperature",
	"8331-1": "Oral temperature",
	"8332-9": "Rectal temperature",
	"8333-7": "Tympanic temperature",
	"85354-9": "Blood pressure panel",
	"8480-6": "Systolic blood pressure",
	"8462-4": "Diastolic blood pressure",
	"8478-0": "Mean blood pressure",
	"2708-6": "Oxygen saturation in blood",
	"59408-5": "Oxygen saturation in arterial blood (pulse oximetry)",
	"19868-9": "Oxygen partial pressure (arterial)",
	"9272-3": "Apgar score (1 min)",
	"9274-9": "Apgar score (5 min)",
	"9271-5": "Apgar score (10 min)",
});

/** Convenience export keyed by canonical LOINC URI. */
export const LOINC_VITALS_REGISTRATION = {
	systemUri: CLINICAL_SYSTEMS.loinc.uri,
	dict: LOINC_VITALS_DICT,
} as const;
