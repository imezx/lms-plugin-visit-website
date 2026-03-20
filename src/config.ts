import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
	.field(
		"maxLinks",
		"numeric",
		{
			displayName: "Max Links",
			min: -1,
			max: 500,
			int: true,
			subtitle: "Maximum number of links returned by the Visit Website tool (0 = Exclude links, -1 = Auto)",
		},
		-1
	)
	.field(
		"maxImages",
		"numeric",
		{
			displayName: "Max Images",
			min: -1,
			max: 500,
			int: true,
			subtitle: "Maximum number of images downloaded and returned by the Visit Website tool (0 = Exclude images, -1 = Auto)",
		},
		-1
	)
	.field(
		"contentLimit",
		"numeric",
		{
			displayName: "Max Content",
			min: -1,
			max: 50_000,
			int: true,
			subtitle: "Maximum text content size returned by the Visit Website tool (0 = Exclude text content, -1 = Auto)",
		},
		-1
	).field(
		"whitelistDomains",
		"string",
		{
			displayName: "Whitelist Domains",
			subtitle: "Subtitle", // Optional subtitle for the field. (Show below the field)
			hint: "a list of domains, eg(lmstudio.ai,github.com)",
			isParagraph: true, // Whether to show a large text input area for this field.
			isProtected: false, // Whether the value should be obscured in the UI (e.g., for passwords).
		},
		"lmstudio.ai", // Default Value
	).build();