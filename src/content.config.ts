import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const docs = defineCollection({
	loader: glob({ pattern: '**/[^_]*.md', base: './src/content/docs' }),
	schema: z.object({
		title: z.string(),
		description: z.string().optional(),
		order: z.number().default(0),
	}),
});

export const collections = { docs };
