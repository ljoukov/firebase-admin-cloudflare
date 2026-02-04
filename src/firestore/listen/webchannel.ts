import {
	WebChannel,
	createWebChannelTransport
} from '@firebase/webchannel-wrapper/webchannel-blob';

import type {
	WebChannel as WebChannelInstance,
	WebChannelOptions
} from '@firebase/webchannel-wrapper/webchannel-blob';

export type WebChannelListener = {
	close(): void;
	send(message: unknown): void;
};

export function openWebChannel(options: {
	baseUrl: string;
	rpcPath: string;
	methodName: string;
	database: string;
	initMessageHeaders: Record<string, string>;
	onMessage: (message: unknown) => void;
	onError: (error: Error) => void;
	onClose: () => void;
}): WebChannelListener {
	const url = `${options.baseUrl.replace(/\/+$/g, '')}/${options.rpcPath}/${options.methodName}/channel`;

	const transport = createWebChannelTransport();
	const channelOptions: WebChannelOptions = {
		httpSessionIdParam: 'gsessionid',
		initMessageHeaders:
			options.initMessageHeaders as unknown as WebChannelOptions['initMessageHeaders'],
		// Required for backend stickiness / routing behavior.
		messageUrlParams: { database: options.database },
		sendRawJson: true,
		supportsCrossDomainXhr: true,
		encodeInitMessageHeaders: true,
		useFetchStreams: true,
		internalChannelParams: {
			forwardChannelRequestTimeoutMs: 600_000
		}
	};

	const channel: WebChannelInstance = transport.createWebChannel(url, channelOptions);

	channel.listen(WebChannel.EventType.MESSAGE, (event) => {
		const data = (event as { data?: unknown }).data;
		if (Array.isArray(data)) {
			for (const entry of data) {
				options.onMessage(entry);
			}
			return;
		}
		if (data !== undefined) {
			options.onMessage(data);
		}
	});

	channel.listen(WebChannel.EventType.ERROR, (event) => {
		const name =
			event && typeof event === 'object' && 'name' in event
				? String((event as { name: unknown }).name)
				: 'error';
		const message =
			event && typeof event === 'object' && 'message' in event
				? String((event as { message: unknown }).message)
				: 'WebChannel error';
		options.onError(new Error(`[webchannel] ${name}: ${message}`));
	});

	channel.listen(WebChannel.EventType.CLOSE, () => {
		options.onClose();
	});

	channel.open();

	return {
		close() {
			channel.close();
		},
		send(message: unknown) {
			channel.send(message);
		}
	};
}
