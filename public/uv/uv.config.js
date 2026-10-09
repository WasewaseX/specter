/*global Ultraviolet*/
/*
 * SPECTER — Ultraviolet service-worker configuration.
 * Open-source engine forked from GitHub: https://github.com/titaniumnetwork-dev/Ultraviolet
 * All engine assets live under /uv/ ; proxied pages live under /service/ ;
 * the TompHTTP bare relay lives under /bare/ (rewritten to the mini service).
 */
self.__uv$config = {
        prefix: "/service/",
        /*
         * plain codec (encodeURIComponent): /service/<url-encoded> stays fully
         * decodable on the server too — <video>/<audio> element requests bypass
         * service workers by spec, so the Next.js /service/* route streams them
         * with native Range support after decoding this same encoding.
         */
        encodeUrl: Ultraviolet.codec.plain.encode,
        decodeUrl: Ultraviolet.codec.plain.decode,
        handler: "/uv/uv.handler.js",
        client: "/uv/uv.client.js",
        bundle: "/uv/uv.bundle.js",
        config: "/uv/uv.config.js",
        sw: "/uv/uv.sw.js",
        /*
         * Specter page hook — injected into every proxied HTML document.
         * Provides: address-bar sync (title/URL), popup → tab conversion,
         * beacon suppression and Data-Saver video deferral.
         */
        inject: [
                {
                        host: ".",
                        injectTo: "head",
                        html: '<script src="/uv/specter-client.js"><\/script>',
                },
        ],
};
