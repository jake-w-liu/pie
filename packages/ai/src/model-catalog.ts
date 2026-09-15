import type { Api, Model, ProviderId } from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;

type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

type ModelApi<TGroups extends ModelGroups, TModelId extends ModelId<TGroups>> = {
	[TApi in keyof TGroups]: TModelId extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups] &
	Api;

export type ModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TModelId in ModelId<TGroups>]: Model<ModelApi<TGroups, TModelId>> & {
		id: TModelId;
		provider: TProvider;
	};
};

export function flattenModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ModelCatalog<TGroups, TProvider> {
	const flat: Record<string, object> = {};
	const seenIn = new Map<string, string>();
	for (const [api, models] of Object.entries(groups)) {
		for (const id of Object.keys(models)) {
			const first = seenIn.get(id);
			if (first !== undefined) {
				throw new Error(`Duplicate model id "${id}" in model catalog groups "${first}" and "${api}"`);
			}
			seenIn.set(id, api);
			flat[id] = (models as Record<string, object>)[id];
		}
	}
	return flat as ModelCatalog<TGroups, TProvider>;
}
