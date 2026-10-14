/** The opt-in's state on this device; `unavailable` means the server has no VAPID key. */
export type PushControlState = "loading" | "unavailable" | "unsupported" | "install" | "blocked" | "off" | "on" | "busy";

export type PushKeyResponse = {
	publicKey: string | null;
	serviceWorker: string;
};

export type PushEnvironment = {
	publicKey: string | null;
	supported: boolean;
	ios: boolean;
	standalone: boolean;
	permission: NotificationPermission | null;
	/** applicationServerKey of the current subscription, base64url, or null when unsubscribed. */
	subscribedKey: string | null;
	subscribed: boolean;
};
