'use strict';

/** پاکسازی دستی همه‌ی پیام‌ها و عکس‌ها از خط فرمان (حساب‌ها دست‌نخورده می‌مانند). */
const { wipeMessages, wipeStatus } = require('../server/cleanup');

const result = wipeMessages('manual-cli');
const next = new Date(wipeStatus().nextWipeAt);
console.log(`${result.messages} پیام و ${result.files} فایل پاک شد.`);
console.log(`پاکسازی خودکار بعدی: ${next.toLocaleString('fa-IR')}`);
