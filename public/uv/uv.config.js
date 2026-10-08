/*global Ultraviolet*/
/*
 * SPECTER — Ultraviolet service-worker configuration.
 * Open-source engine forked from GitHub: https://github.com/titaniumnetwork-dev/Ultraviolet
 * All engine assets live under /uv/ ; proxied pages live under /service/ ;
 * the TompHTTP bare relay lives under /bare/ (rewritten to the mini service).
 */
self.__uv$config = {
	prefix: "/service/",
	encodeUrl: Ultraviolet.codec.xor.encode,
	decodeUrl: Ultraviolet.codec.xor.decode,
	handler: "/uv/uv.handler.js",
	client: "/uv/uv.client.js",
	bundle: "/uv/uv.bundle.js",
	config: "/uv/uv.config.js",
	sw: "/uv/uv.sw.js",
};
