// config.ts — fonte única de verdade (SSOT) para identificadores externos do site.

/** Código do site no GoatCounter (https://<codigo>.goatcounter.com). */
export const GOATCOUNTER_CODE = 'bramosjr';

/** Endpoint de coleta de visitas (usado pelo script count.js). */
export const GOATCOUNTER_COUNT_URL = `https://${GOATCOUNTER_CODE}.goatcounter.com/count`;

/** Endpoint público de leitura do total do site (visitas e únicos). */
export const GOATCOUNTER_TOTAL_URL = `https://${GOATCOUNTER_CODE}.goatcounter.com/counter/TOTAL.json`;
