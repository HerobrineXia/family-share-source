import { definePlugin, IconsModule, sleep, callable, Field, TextField, DialogButton } from '@steambrew/client';

const PLUGIN_TAG = '[steam-family-share-source]';
const SYNC_MIN_INTERVAL_MS = 15000;
const ROUTE_TICK_MS = 1500;
const LENDER_CACHE_KEY = 'sfs.lenderCache.v1';
const COLLECTION_NAME_BACKUP_KEY = 'sfs.collectionNameBackup.v1';
const OWNER_NAME_OVERRIDE_KEY = 'sfs.ownerNameOverrides.v1';
const COLLECTION_NAME_TEMPLATE_KEY = 'sfs.collectionNameTemplate.v1';
const DEFAULT_COLLECTION_NAME_TEMPLATE = '{name}的游戏库';
const LENDER_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const LEGACY_COLLECTION_NAME = 'hello';
const React = (window as any).SP_REACT as typeof import('react');

type LenderCacheItem = {
	ownerId: string;
	ownerName?: string;
	updatedAt: number;
};

type SettingsOwnerRow = {
	ownerId: string;
	username: string;
	webOwnerName: string;
	defaultUsername: string;
	statusMessage: string;
	saving: boolean;
};

const toAppId = (app: any): number | null => {
	if (typeof app === 'number') return app;
	if (typeof app?.appid === 'number') return app.appid;
	if (typeof app?.m_unAppID === 'number') return app.m_unAppID;
	return null;
};

const uniqueNumbers = (ids: number[]) => Array.from(new Set(ids));
const sanitizeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, '').trim();
const shortOwnerId = (ownerId: string) => {
	const normalized = ownerId.trim();
	if (!normalized) return '';
	return normalized.length > 6 ? normalized.slice(-6) : normalized;
};

const fallbackOwnerName = (ownerId: string) => shortOwnerId(ownerId);

const loadJsonLocal = (key: string): any => {
	try {
		const raw = localStorage.getItem(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
};

const saveJsonLocal = (key: string, value: any) => {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch (e) {
		console.warn(`${PLUGIN_TAG} Failed to save local storage key=${key}`, e);
	}
};

const storageGet = callable<[{ key: string }], any>('storage_get');
const storageSet = callable<[{ key: string; value: string }], boolean>('storage_set');
const resolveOwnerNames = callable<[{ steam_ids_csv: string; force_refresh?: boolean }], string>('resolve_owner_names');

const parseJsonPayload = (key: string, raw: any): any => {
	if (raw == null) return null;
	if (typeof raw !== 'string') {
		// backward compatibility for old backend data that stored raw objects
		return raw;
	}
	try {
		return JSON.parse(raw);
	} catch (e) {
		console.warn(`${PLUGIN_TAG} Failed to parse storage payload key=${key}`, e);
		return null;
	}
};

const loadJson = async (key: string): Promise<any> => {
	try {
		const raw = await storageGet({ key });
		return parseJsonPayload(key, raw);
	} catch (e) {
		console.warn(`${PLUGIN_TAG} Storage backend get failed, falling back to localStorage`, e);
	}
	return loadJsonLocal(key);
};

const saveJson = async (key: string, value: any) => {
	let raw = '';
	try {
		raw = JSON.stringify(value);
	} catch (e) {
		console.warn(`${PLUGIN_TAG} Failed to serialize payload key=${key}`, e);
		return;
	}
	try {
		const ok = await storageSet({ key, value: raw });
		if (ok) return;
	} catch (e) {
		console.warn(`${PLUGIN_TAG} Storage backend set failed, falling back to localStorage`, e);
	}
	saveJsonLocal(key, value);
};

const loadLenderCache = async (): Promise<Record<string, LenderCacheItem>> => {
	const parsed = loadJsonLocal(LENDER_CACHE_KEY);
	if (parsed && typeof parsed === 'object') return parsed as Record<string, LenderCacheItem>;
	return {};
};

const saveLenderCache = (cache: Record<string, LenderCacheItem>) => saveJsonLocal(LENDER_CACHE_KEY, cache);

const loadCollectionNameBackup = async (): Promise<Record<string, string>> => {
	const parsed = await loadJson(COLLECTION_NAME_BACKUP_KEY);
	if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
	return {};
};

const sanitizeCollectionNameBackup = (map: Record<string, string>): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [ownerId, collectionName] of Object.entries(map)) {
		if (typeof ownerId !== 'string' || !ownerId.trim()) continue;
		if (typeof collectionName !== 'string' || !collectionName.trim()) continue;
		out[ownerId.trim()] = collectionName.trim();
	}
	return out;
};

const saveCollectionNameBackup = (map: Record<string, string>) =>
	saveJson(COLLECTION_NAME_BACKUP_KEY, sanitizeCollectionNameBackup(map));

const sanitizeOwnerNameOverrides = (map: Record<string, string>): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const [ownerId, ownerName] of Object.entries(map)) {
		if (typeof ownerId !== 'string' || !ownerId.trim()) continue;
		if (typeof ownerName !== 'string') continue;
		const name = ownerName.trim();
		if (!name) continue;
		out[ownerId.trim()] = name;
	}
	return out;
};

const loadOwnerNameOverrides = async (): Promise<Record<string, string>> => {
	const parsed = await loadJson(OWNER_NAME_OVERRIDE_KEY);
	if (parsed && typeof parsed === 'object') return sanitizeOwnerNameOverrides(parsed as Record<string, string>);
	return {};
};

const saveOwnerNameOverrides = (map: Record<string, string>) => saveJson(OWNER_NAME_OVERRIDE_KEY, sanitizeOwnerNameOverrides(map));

const normalizeCollectionTemplate = (template: string): string => {
	const trimmed = template.trim();
	const base = trimmed || DEFAULT_COLLECTION_NAME_TEMPLATE;
	return base.includes('{name}') ? base : `${base}{name}`;
};

const loadCollectionNameTemplate = async (): Promise<string> => {
	const parsed = await loadJson(COLLECTION_NAME_TEMPLATE_KEY);
	if (typeof parsed === 'string') return normalizeCollectionTemplate(parsed);
	return DEFAULT_COLLECTION_NAME_TEMPLATE;
};

const saveCollectionNameTemplate = (template: string) =>
	saveJson(COLLECTION_NAME_TEMPLATE_KEY, normalizeCollectionTemplate(template));

const pickString = (obj: any, keys: string[]): string | null => {
	for (const key of keys) {
		const value = obj?.[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return null;
};

const fetchOwnerNamesFromWeb = async (ownerIds: string[], forceRefresh = false): Promise<Map<string, string>> => {
	if (ownerIds.length === 0) return new Map();
	try {
		const raw = await resolveOwnerNames({ steam_ids_csv: ownerIds.join(','), force_refresh: forceRefresh });
		if (typeof raw !== 'string' || !raw.trim()) return new Map();
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return new Map();
		const result = new Map<string, string>();
		for (const [steamId, ownerName] of Object.entries(parsed as Record<string, string>)) {
			if (typeof steamId !== 'string' || typeof ownerName !== 'string') continue;
			const sid = steamId.trim();
			const name = ownerName.trim();
			if (!sid || !name) continue;
			result.set(sid, name);
		}
		return result;
	} catch (e) {
		console.warn(`${PLUGIN_TAG} Failed to fetch user names via web`, e);
		return new Map();
	}
};

const buildOwnerCollectionName = (ownerDisplayName: string, template: string): string => {
	const username = sanitizeName(ownerDisplayName) || shortOwnerId(ownerDisplayName) || 'unknown';
	const normalizedTemplate = normalizeCollectionTemplate(template);
	const rendered = normalizedTemplate.split('{name}').join(username);
	return sanitizeName(rendered) || `${username}的游戏库`;
};

const getCollectionById = (collectionStore: any, collectionId: string): any | null => {
	if (!collectionId) return null;
	try {
		if (typeof collectionStore.GetCollection === 'function') {
			return collectionStore.GetCollection(collectionId) ?? null;
		}
	} catch {
		// ignore
	}
	if (Array.isArray(collectionStore.userCollections)) {
		const found = collectionStore.userCollections.find((c: any) => c?.m_strId === collectionId);
		if (found) return found;
	}
	return null;
};

const getCollectionByName = (collectionStore: any, name: string): any | null => {
	if (!name) return null;
	try {
		if (typeof collectionStore.GetUserCollectionsByName === 'function') {
			const list = collectionStore.GetUserCollectionsByName(name);
			if (Array.isArray(list) && list.length > 0) return list[0];
		}
	} catch {
		// ignore
	}
	if (Array.isArray(collectionStore.userCollections)) {
		const found = collectionStore.userCollections.find((c: any) => c?.m_strName === name);
		if (found) return found;
	}
	return null;
};

const deleteCollection = (collectionStore: any, collection: any) => {
	if (!collection) return;
	try {
		if (typeof collection.Delete === 'function') {
			collection.Delete();
			return;
		}
	} catch {
		// ignore
	}
	try {
		if (typeof collectionStore.DeleteCollection === 'function' && collection.m_strId) {
			collectionStore.DeleteCollection(collection.m_strId);
		}
	} catch {
		// ignore
	}
};

const createCollection = async (collectionStore: any, name: string): Promise<any | null> => {
	if (typeof collectionStore.NewUnsavedCollection !== 'function') return null;
	const coll = collectionStore.NewUnsavedCollection(name, undefined, []);
	if (!coll) return null;
	try {
		if (typeof coll.Save === 'function') await coll.Save();
	} catch {
		// ignore
	}
	return coll;
};

const renameOrRecreateCollection = async (collectionStore: any, collection: any, desiredName: string): Promise<any | null> => {
	if (!collection) return null;
	if (collection.m_strName === desiredName) return collection;

	try {
		if (typeof collection.SetName === 'function') {
			collection.SetName(desiredName);
			if (typeof collection.Save === 'function') await collection.Save();
			return getCollectionById(collectionStore, collection.m_strId) ?? collection;
		}
	} catch {
		// ignore
	}

	try {
		if (typeof collectionStore.RenameCollection === 'function' && collection.m_strId) {
			await collectionStore.RenameCollection(collection.m_strId, desiredName);
			return getCollectionById(collectionStore, collection.m_strId) ?? getCollectionByName(collectionStore, desiredName);
		}
	} catch {
		// ignore
	}

	const oldAppIds = uniqueNumbers(
		(Array.isArray(collection.allApps) ? collection.allApps : [])
			.map(toAppId)
			.filter((id: number | null): id is number => id !== null),
	);
	const next = await createCollection(collectionStore, desiredName);
	if (!next?.m_strId) return collection;
	if (oldAppIds.length > 0 && typeof collectionStore.AddOrRemoveApp === 'function') {
		collectionStore.AddOrRemoveApp(oldAppIds, true, next.m_strId);
	}
	deleteCollection(collectionStore, collection);
	return next;
};

const extractSharedEntries = (collectionStore: any): any[] => {
	const candidates = [
		collectionStore.sharedLibrariesCollections,
		collectionStore.m_sharedLibrariesCollections,
		collectionStore.m_rgSharedLibrariesCollections,
		collectionStore.sharedLibraries,
		collectionStore.m_rgSharedLibraries,
	];
	for (const candidate of candidates) {
		if (Array.isArray(candidate) && candidate.length > 0) return candidate;
	}
	return [];
};

const resolveOwnersFromSharedCollections = (collectionStore: any) => {
	const appOwnerMap = new Map<number, string>();
	const ownerNameHint = new Map<string, string>();
	const allSharedAppIds: number[] = [];

	const entries = extractSharedEntries(collectionStore);
	for (const entry of entries) {
		const ownerId = pickString(entry, [
			'steamid',
			'strSteamID',
			'm_strSteamID',
			'owner_steamid',
			'strOwnerSteamID',
			'm_strOwnerSteamID',
			'library_steamid',
			'm_steamid',
		]);
		const ownerName =
			pickString(entry, [
				'owner_name',
				'strOwnerName',
				'm_strOwnerName',
				'lender_name',
				'strLenderName',
				'm_strLenderName',
				'persona_name',
				'strPersonaName',
				'm_strPersonaName',
				'display_name',
				'strDisplayName',
				'm_strDisplayName',
				'name',
				'strName',
				'm_strName',
			]) ??
			pickString(entry?.owner, ['name', 'strName', 'm_strName', 'persona_name', 'strPersonaName']) ??
			pickString(entry?.lender, ['name', 'strName', 'm_strName', 'persona_name', 'strPersonaName']);

		const appIds = uniqueNumbers(
			(Array.isArray(entry?.allApps) ? entry.allApps : [])
				.map(toAppId)
				.filter((id: number | null): id is number => id !== null),
		);
		allSharedAppIds.push(...appIds);

		if (!ownerId) continue;
		if (ownerName && !ownerNameHint.has(ownerId)) ownerNameHint.set(ownerId, ownerName);

		for (const appId of appIds) {
			if (!appOwnerMap.has(appId)) appOwnerMap.set(appId, ownerId);
		}
	}

	return {
		appOwnerMap,
		ownerNameHint,
		allSharedAppIds: uniqueNumbers(allSharedAppIds),
	};
};

const pickPreferredLender = (lenders: any[]): string | null => {
	if (!Array.isArray(lenders) || lenders.length === 0) return null;
	const preferred = lenders.find((x: any) => x?.bPreferred && typeof x?.steamid === 'string');
	if (preferred?.steamid) return preferred.steamid;
	const first = lenders.find((x: any) => typeof x?.steamid === 'string');
	return first?.steamid ?? null;
};

const resolveMissingOwnersByApi = async (
	missingAppIds: number[],
	appOwnerMap: Map<number, string>,
	ownerNameHint: Map<string, string>,
) => {
	const steamClient = (globalThis as any).SteamClient;
	const familyApi = steamClient?.FamilySharing;
	if (!familyApi || typeof familyApi.GetAvailableLenders !== 'function' || missingAppIds.length === 0) return;

	const cache = await loadLenderCache();
	const now = Date.now();
	const toQuery: number[] = [];

	for (const appId of missingAppIds) {
		const cached = cache[String(appId)];
		if (cached && now - cached.updatedAt <= LENDER_CACHE_TTL_MS && typeof cached.ownerId === 'string') {
			appOwnerMap.set(appId, cached.ownerId);
			if (cached.ownerName && !ownerNameHint.has(cached.ownerId)) ownerNameHint.set(cached.ownerId, cached.ownerName);
		} else {
			toQuery.push(appId);
		}
	}

	const concurrency = 8;
	let index = 0;
	const workers = Array.from({ length: Math.min(concurrency, toQuery.length) }).map(async () => {
		while (index < toQuery.length) {
			const i = index;
			index += 1;
			const appId = toQuery[i];
			try {
				const lenders = await familyApi.GetAvailableLenders(appId);
				const ownerId = pickPreferredLender(lenders);
				if (!ownerId) continue;

				const ownerObj = Array.isArray(lenders) ? lenders.find((x: any) => x?.steamid === ownerId) : null;
				const ownerName = pickString(ownerObj, ['strName', 'name', 'persona_name', 'strPersonaName', 'display_name']) ?? undefined;

				appOwnerMap.set(appId, ownerId);
				if (ownerName && !ownerNameHint.has(ownerId)) ownerNameHint.set(ownerId, ownerName);
				cache[String(appId)] = { ownerId, ownerName, updatedAt: Date.now() };
			} catch {
				// ignore
			}
		}
	});

	await Promise.all(workers);
	await saveLenderCache(cache);
};

const resolveOwnerDisplayName = (
	ownerId: string,
	ownerNamesFromWeb: Map<string, string>,
	ownerNameOverrides: Record<string, string>,
): string => {
	const override = ownerNameOverrides[ownerId]?.trim();
	if (override) return override;

	const fromWeb = ownerNamesFromWeb.get(ownerId)?.trim();
	if (fromWeb) return fromWeb;

	return fallbackOwnerName(ownerId);
};

const syncCollectionMembers = (collectionStore: any, collection: any, targetIds: number[]) => {
	if (!collection?.m_strId || typeof collectionStore.AddOrRemoveApp !== 'function') return;

	const currentIds = new Set<number>(
		(Array.isArray(collection.allApps) ? collection.allApps : [])
			.map(toAppId)
			.filter((id: number | null): id is number => id !== null),
	);
	const targetSet = new Set(targetIds);

	const removeIds: number[] = [];
	for (const id of currentIds) {
		if (!targetSet.has(id)) removeIds.push(id);
	}
	if (removeIds.length > 0) collectionStore.AddOrRemoveApp(removeIds, false, collection.m_strId);

	const addIds = targetIds.filter((id: number) => !currentIds.has(id));
	if (addIds.length > 0) {
		const batchSize = 100;
		for (let i = 0; i < addIds.length; i += batchSize) {
			collectionStore.AddOrRemoveApp(addIds.slice(i, i + batchSize), true, collection.m_strId);
		}
	}
};

const removeLegacyHelloCollection = (collectionStore: any) => {
	const legacy = getCollectionByName(collectionStore, LEGACY_COLLECTION_NAME);
	if (legacy) {
		deleteCollection(collectionStore, legacy);
		console.log(`${PLUGIN_TAG} Removed legacy hello collection`);
	}
};

const waitForCollectionStore = async (): Promise<any | null> => {
	const App = (globalThis as any).App;
	const collectionStore = (globalThis as any).collectionStore;
	if (!App || !collectionStore) return null;
	await App.WaitForServicesInitialized();
	return collectionStore;
};

const resolveOwnerGroups = async (
	collectionStore: any,
): Promise<{ ownerToApps: Map<string, number[]>; ownerNameHint: Map<string, string> }> => {
	const { appOwnerMap, ownerNameHint, allSharedAppIds } = resolveOwnersFromSharedCollections(collectionStore);
	const missingAppIds = allSharedAppIds.filter((appId: number) => !appOwnerMap.has(appId));
	await resolveMissingOwnersByApi(missingAppIds, appOwnerMap, ownerNameHint);

	const ownerToApps = new Map<string, number[]>();
	for (const [appId, ownerId] of appOwnerMap.entries()) {
		if (!ownerToApps.has(ownerId)) ownerToApps.set(ownerId, []);
		ownerToApps.get(ownerId)!.push(appId);
	}

	return { ownerToApps, ownerNameHint };
};

const applyOwnerNameOverride = async (
	ownerId: string,
	inputOwnerName: string,
	defaultUsername: string,
): Promise<{ ok: boolean; error?: string }> => {
	const ownerNameOverrides = await loadOwnerNameOverrides();
	const normalizedOwnerName = inputOwnerName.trim();
	if (normalizedOwnerName && normalizedOwnerName !== defaultUsername) {
		ownerNameOverrides[ownerId] = normalizedOwnerName;
	} else {
		delete ownerNameOverrides[ownerId];
	}
	await saveOwnerNameOverrides(ownerNameOverrides);
	return { ok: true };
};

const loadSettingsRows = async (forceRefreshNames = false): Promise<SettingsOwnerRow[]> => {
	const collectionStore = await waitForCollectionStore();
	if (!collectionStore) return [];

	await sleep(100);
	const collectionNameBackup = sanitizeCollectionNameBackup(await loadCollectionNameBackup());
	const ownerNameOverrides = await loadOwnerNameOverrides();
	const { ownerToApps } = await resolveOwnerGroups(collectionStore);
	const ownerIds = Array.from(new Set<string>([...Object.keys(collectionNameBackup), ...ownerToApps.keys()]));
	if (ownerIds.length === 0) return [];

	const ownerNamesFromWeb = await fetchOwnerNamesFromWeb(ownerIds, forceRefreshNames);

	return ownerIds
		.sort((a: string, b: string) => a.localeCompare(b))
		.map((ownerId: string) => {
			const webOwnerName = ownerNamesFromWeb.get(ownerId)?.trim() ?? '';
			const defaultUsername = webOwnerName || fallbackOwnerName(ownerId);
			const username = ownerNameOverrides[ownerId]?.trim() || defaultUsername;
			return {
				ownerId,
				username,
				webOwnerName,
				defaultUsername,
				statusMessage: '',
				saving: false,
			};
		});
};

type SyncOptions = {
	forceRefreshNames?: boolean;
};

const runSync = async (options: SyncOptions = {}) => {
	const forceRefreshNames = options.forceRefreshNames === true;

	const collectionStore = await waitForCollectionStore();
	if (!collectionStore) return;

	await sleep(200);

	removeLegacyHelloCollection(collectionStore);

	const collectionNameBackup = sanitizeCollectionNameBackup(await loadCollectionNameBackup());
	const ownerNameOverrides = await loadOwnerNameOverrides();
	const collectionNameTemplate = await loadCollectionNameTemplate();
	const { ownerToApps } = await resolveOwnerGroups(collectionStore);

	const ownerIds = Array.from(ownerToApps.keys());
	const ownerNamesFromWeb = await fetchOwnerNamesFromWeb(ownerIds, forceRefreshNames);

	if (ownerToApps.size === 0) {
		console.warn(`${PLUGIN_TAG} No owner groups resolved`);
		return;
	}

	for (const [ownerId, appIds] of ownerToApps.entries()) {
		const backupCollectionName = collectionNameBackup[ownerId];
		const displayName = resolveOwnerDisplayName(ownerId, ownerNamesFromWeb, ownerNameOverrides);
		const desiredCollectionName = buildOwnerCollectionName(displayName, collectionNameTemplate);

		let collection = backupCollectionName ? getCollectionByName(collectionStore, backupCollectionName) : null;
		if (!collection) collection = getCollectionByName(collectionStore, desiredCollectionName);
		if (!collection) collection = await createCollection(collectionStore, desiredCollectionName);
		if (!collection) continue;

		collection = await renameOrRecreateCollection(collectionStore, collection, desiredCollectionName);
		if (!collection) continue;

		syncCollectionMembers(collectionStore, collection, uniqueNumbers(appIds));

		const actualCollectionName = collection.m_strName ?? desiredCollectionName;
		if (backupCollectionName !== actualCollectionName) {
			collectionNameBackup[ownerId] = actualCollectionName;
		}
	}

	await saveCollectionNameBackup(collectionNameBackup);
	console.log(`${PLUGIN_TAG} Synced owner collections (${ownerToApps.size} owners)`);
};

let started = false;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncRunning = false;
let lastSyncAt = 0;

const guardedSync = async (force = false, options: SyncOptions = {}) => {
	if (syncRunning) return;
	if (!force && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) return;
	syncRunning = true;
	try {
		await runSync(options);
		lastSyncAt = Date.now();
	} catch (e) {
		console.error(`${PLUGIN_TAG} Sync failed`, e);
	} finally {
		syncRunning = false;
	}
};

const setupRouteSync = async (popup: any) => {
	if (started) return;
	if (popup?.m_strName !== 'SP Desktop_uid0') return;
	started = true;

	while (!(globalThis as any).MainWindowBrowserManager) {
		await sleep(100);
	}
	const mwbm = (globalThis as any).MainWindowBrowserManager;

	const syncOnRoute = async () => {
		const path = mwbm.m_lastLocation?.pathname ?? '';
		if (path === '/library' || path.startsWith('/library/collections')) {
			await guardedSync(false);
		}
	};

	mwbm.m_browser.on('finished-request', async () => {
		await syncOnRoute();
	});

	syncTimer = setInterval(() => {
		void syncOnRoute();
	}, ROUTE_TICK_MS);

	await guardedSync(true);
};

const SettingsContent = () => {
	const [rows, setRows] = React.useState<SettingsOwnerRow[]>([]);
	const [loading, setLoading] = React.useState(true);
	const [loadError, setLoadError] = React.useState('');
	const [refreshingNames, setRefreshingNames] = React.useState(false);
	const [collectionTemplate, setCollectionTemplate] = React.useState(DEFAULT_COLLECTION_NAME_TEMPLATE);
	const [savingTemplate, setSavingTemplate] = React.useState(false);

	const refreshRows = React.useCallback(async (forceRefreshNames = false) => {
		setLoading(true);
		setLoadError('');
		try {
			const [nextRows, nextTemplate] = await Promise.all([
				loadSettingsRows(forceRefreshNames),
				loadCollectionNameTemplate(),
			]);
			setRows(nextRows);
			setCollectionTemplate(nextTemplate);
		} catch (e) {
			console.error(`${PLUGIN_TAG} Failed to load settings rows`, e);
			setLoadError('Failed to load family collections');
			setRows([]);
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		void refreshRows();
	}, [refreshRows]);

	const refreshAllOwnerNames = React.useCallback(async () => {
		setRefreshingNames(true);
		try {
			await guardedSync(true, { forceRefreshNames: true });
			await refreshRows(false);
		} finally {
			setRefreshingNames(false);
		}
	}, [refreshRows]);

	const onNameChange = React.useCallback((ownerId: string, ownerNameOverride: string) => {
		setRows((prev: SettingsOwnerRow[]) =>
			prev.map((row: SettingsOwnerRow) =>
				row.ownerId === ownerId ? { ...row, username: ownerNameOverride, statusMessage: '', saving: false } : row,
			),
		);
	}, []);

	const applyRowUpdate = React.useCallback(
		async (ownerId: string, inputOwnerName: string) => {
			const rowSnapshot = rows.find((row: SettingsOwnerRow) => row.ownerId === ownerId);
			if (!rowSnapshot) return;

			setRows((prev: SettingsOwnerRow[]) =>
				prev.map((row: SettingsOwnerRow) =>
					row.ownerId === ownerId ? { ...row, saving: true, statusMessage: 'Applying changes...' } : row,
				),
			);

			const result = await applyOwnerNameOverride(ownerId, inputOwnerName, rowSnapshot.defaultUsername);
			if (!result.ok) {
				setRows((prev: SettingsOwnerRow[]) =>
					prev.map((row: SettingsOwnerRow) =>
						row.ownerId === ownerId
							? { ...row, saving: false, statusMessage: result.error ?? 'Failed to apply changes' }
							: row,
					),
				);
				return;
			}

			await guardedSync(true);
			await refreshRows(false);
		},
		[refreshRows, rows],
	);

	const applyTemplateUpdate = React.useCallback(async () => {
		setSavingTemplate(true);
		try {
			const normalized = normalizeCollectionTemplate(collectionTemplate);
			setCollectionTemplate(normalized);
			await saveCollectionNameTemplate(normalized);
			await guardedSync(true);
			await refreshRows(false);
		} finally {
			setSavingTemplate(false);
		}
	}, [collectionTemplate, refreshRows]);

	if (loading) {
		return (
			<Field
				label="Family Library Collections"
				description="Loading owner IDs and settings..."
				padding="compact"
				bottomSeparator="none"
				focusable={false}
			/>
		);
	}

	if (loadError) {
		return (
			<>
				<Field
					label="Family Library Collections"
					description={loadError}
					padding="compact"
					bottomSeparator="standard"
					focusable={false}
				/>
				<DialogButton disabled={refreshingNames} onClick={() => void refreshAllOwnerNames()}>
					{refreshingNames ? 'Refreshing names...' : 'Reload Owner Names'}
				</DialogButton>
				<DialogButton disabled={savingTemplate} onClick={() => void applyTemplateUpdate()}>
					{savingTemplate ? 'Applying template...' : 'Apply Template'}
				</DialogButton>
				<DialogButton onClick={() => void refreshRows()}>Retry</DialogButton>
			</>
		);
	}

	return (
		<>
			<Field
				label="Family Library Collections"
				description="Collection name is auto generated from template. If web name is unavailable, username defaults to steam_id last 6 digits."
				padding="compact"
				bottomSeparator="thick"
				focusable={false}
			/>
			<Field
				label="Collection Name Template"
				description="Use {name} as placeholder, e.g. {name}的游戏库"
				padding="compact"
				bottomSeparator="standard"
				focusable={false}
				childrenLayout="below"
			>
				<TextField
					label="Template"
					value={collectionTemplate}
					disabled={savingTemplate}
					onChange={(e: any) => setCollectionTemplate(e.currentTarget.value)}
					onKeyDown={(e: any) => {
						if (e.key === 'Enter') {
							e.preventDefault();
							void applyTemplateUpdate();
						}
					}}
				/>
				<DialogButton
					disabled={savingTemplate}
					style={{ width: 'fit-content', minWidth: '120px', paddingLeft: '10px', paddingRight: '10px', flex: '0 0 auto' }}
					onClick={() => void applyTemplateUpdate()}
				>
					{savingTemplate ? 'Applying template...' : 'Apply Template'}
				</DialogButton>
			</Field>
			<DialogButton disabled={refreshingNames} onClick={() => void refreshAllOwnerNames()}>
				{refreshingNames ? 'Refreshing names...' : 'Reload Owner Names'}
			</DialogButton>
			{rows.length === 0 ? (
				<Field
					label="No family owners found"
					description="Open the Steam library page once, then retry."
					padding="compact"
					bottomSeparator="none"
					focusable={false}
				/>
			) : null}
			{rows.map((row: SettingsOwnerRow) => [
				<Field
					key={`${row.ownerId}-owner`}
					label="Family Owner"
					description={
						row.statusMessage ||
						(row.webOwnerName
							? `Web name: ${row.webOwnerName}`
							: `Web name unavailable, default username: ${row.defaultUsername}`)
					}
					padding="compact"
					childrenLayout="below"
					bottomSeparator="none"
					focusable={false}
				>
					<TextField label="Steam ID" value={row.ownerId} onChange={() => undefined} bShowCopyAction />
				</Field>,
				<Field key={`${row.ownerId}-name`} padding="compact" childrenLayout="below" bottomSeparator="none" focusable={false}>
					<TextField
						label="Username"
						value={row.username}
						disabled={row.saving}
						onChange={(e: any) => onNameChange(row.ownerId, e.currentTarget.value)}
						onKeyDown={(e: any) => {
							if (e.key === 'Enter') {
								e.preventDefault();
								void applyRowUpdate(row.ownerId, e.currentTarget.value);
							}
						}}
					/>
				</Field>,
				<Field key={`${row.ownerId}-apply`} padding="compact" childrenLayout="below" bottomSeparator="standard" focusable={false}>
					<DialogButton
						disabled={row.saving}
						style={{ width: 'fit-content', minWidth: '88px', paddingLeft: '10px', paddingRight: '10px', flex: '0 0 auto' }}
						onClick={() => {
							void applyRowUpdate(row.ownerId, row.username);
						}}
					>
						{row.saving ? 'Applying...' : 'Apply'}
					</DialogButton>
				</Field>,
			])}
		</>
	);
};

export default definePlugin(() => {
	console.log(`${PLUGIN_TAG} plugin loaded (owner collection mode)`);

	(async () => {
		while (!(globalThis as any).g_PopupManager) {
			await sleep(100);
		}
		const popupManager = (globalThis as any).g_PopupManager;
		const desktopPopup = popupManager.GetExistingPopup('SP Desktop_uid0');
		if (desktopPopup) await setupRouteSync(desktopPopup);
		popupManager.AddPopupCreatedCallback(setupRouteSync);
	})();

	return {
		title: 'Family Share Source',
		icon: <IconsModule.Settings />,
		content: <SettingsContent />,
		onUnload: () => {
			if (syncTimer) clearInterval(syncTimer);
			syncTimer = null;
			started = false;
		},
	};
});

