'use strict';

/**
 * ساخت یا ارتقای حساب مدیر از خط فرمان.
 * کاربرد: node scripts/create-admin.js <username> <password> [نام نمایشی]
 */
const store = require('../server/store');

const [username, password, displayName] = process.argv.slice(2);

if (!username || !password) {
  console.error('کاربرد: node scripts/create-admin.js <username> <password> [نام نمایشی]');
  process.exit(1);
}
if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
  console.error('نام کاربری باید ۳ تا ۲۴ نویسه انگلیسی، عدد یا _ باشد.');
  process.exit(1);
}
if (password.length < 8) {
  console.error('رمز عبور باید حداقل ۸ نویسه باشد.');
  process.exit(1);
}

const existing = store.getUserByUsername(username);

if (existing) {
  store.setUserPassword(existing.id, password);
  store.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(existing.id);
  store.setUserStatus(existing.id, 'approved', existing.id);
  console.log(`حساب @${username} به مدیر ارتقا یافت و رمزش تغییر کرد.`);
} else {
  const user = store.createUser({
    username,
    displayName: displayName || username,
    password,
    status: 'approved',
    isAdmin: true,
  });
  console.log(`حساب مدیر @${user.username} ساخته شد (شناسه ${user.id}).`);
}
