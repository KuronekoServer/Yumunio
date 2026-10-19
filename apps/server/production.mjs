// A new production installation is prepared automatically. Existing manual
// account deployments and explicit WEB_SETUP choices keep their configuration.
if (process.env.YUMUNIO_WEB_SETUP === undefined && !process.env.YUMUNIO_ACCESS_KEY && !process.env.YUMUNIO_AUTH_SECRET && process.env.YUMUNIO_ACCOUNTS_ENABLED !== 'true') process.env.YUMUNIO_WEB_SETUP = 'true';
