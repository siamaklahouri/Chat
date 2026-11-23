/* 9chat — لایه‌ی زبان.
 *
 * کلیدِ هر رشته، خودِ متن فارسی است. دو دلیل دارد:
 *   ۱) هیچ متنی جا نمی‌ماند؛ اگر ترجمه‌ای نباشد، فارسی نشان داده می‌شود،
 *      نه یک کلید بی‌معنی مثل «login.title» که کاربر ببیند.
 *   ۲) جابه‌جایی متن در کد، کلید را نمی‌شکند.
 *
 * جاهای متغیر با {n}، {name} و مانند آن نوشته می‌شوند.
 */
(() => {
  'use strict';

  const LANG_KEY = 'messenger.lang';
  const LANGS = [
    ['fa', 'فارسی', 'rtl'],
    ['en', 'English', 'ltr'],
  ];

  const EN = {
    /* --- زمان و اندازه --- */
    'امروز': 'Today',
    'دیروز': 'Yesterday',
    'همین حالا': 'just now',
    '{n} دقیقه پیش': '{n} min ago',
    '{n} ساعت پیش': '{n} h ago',
    '{n} روز پیش': '{n} d ago',
    'بایت': 'B',
    'کیلوبایت': 'KB',
    'مگابایت': 'MB',

    /* --- ظاهر --- */
    'ظاهر': 'Appearance',
    'تم': 'Theme',
    'خودکار': 'Auto',
    'روشن': 'Light',
    'تیره': 'Dark',
    'رنگ': 'Color',
    'رنگ {label}': '{label}',
    'بنفش‌آبی': 'Indigo',
    'بنفش': 'Violet',
    'آبی': 'Blue',
    'فیروزه‌ای': 'Teal',
    'سرخابی': 'Rose',
    'کهربایی': 'Amber',
    'پس‌زمینه‌ی گفتگو': 'Chat background',
    'پس‌زمینه‌ی {label}': '{label} background',
    'شفق': 'Aurora',
    'مه رنگی': 'Mesh',
    'غروب': 'Sunset',
    'شب': 'Night',
    'اقیانوس': 'Ocean',
    'جنگل': 'Forest',
    'ارغوانی': 'Plum',
    'نقطه‌چین': 'Dots',
    'شبکه': 'Grid',
    'راه‌راه': 'Stripes',
    'ساده': 'Plain',
    'عکس از گالری': 'Photo from gallery',
    'انتخاب عکس پس‌زمینه از گالری': 'Choose a background photo from your gallery',
    'برداشتن عکس پس‌زمینه': 'Remove background photo',
    'پس‌زمینه عوض شد.': 'Background changed.',
    'این عکس خیلی بزرگ است؛ عکس کوچک‌تری انتخاب کنید.': 'That photo is too large; pick a smaller one.',
    'جای کافی در این مرورگر نیست؛ عکس کوچک‌تری انتخاب کنید.': 'Not enough room in this browser; pick a smaller photo.',
    'زبان': 'Language',

    /* --- ورود و حساب --- */
    'خطای ناشناخته': 'Unknown error',
    'در حال ورود…': 'Signing in…',
    'در حال ثبت‌نام…': 'Signing up…',
    'نشست شما منقضی شده است. دوباره وارد شوید.': 'Your session has expired. Please sign in again.',
    'حساب شما مسدود شده است.': 'Your account has been blocked.',
    'حساب شما هنوز تایید نشده است.': 'Your account has not been approved yet.',
    'حساب شما هنوز توسط مدیر تایید نشده است.': 'An admin has not approved your account yet.',
    '9chat ایمیل و شماره‌ی شما را نمی‌گیرد، پس بازیابی خودکار رمز ممکن نیست. ':
      '9chat does not collect your email or phone number, so there is no automatic password reset. ',
    'از مدیر بخواهید از پنل مدیریت برایتان رمز تازه بگذارد.':
      'Ask an admin to set a new password for you from the admin panel.',
    'نمایش رمز': 'Show password',
    'پنهان کردن رمز': 'Hide password',

    /* --- فهرست گفتگوها --- */
    'هنوز پیامی رد و بدل نشده': 'No messages yet',
    'شما: ': 'You: ',
    'گفتگویی پیدا نشد.': 'No conversations found.',
    'هنوز گفتگویی ندارید. با دکمه + شروع کنید.': 'No conversations yet. Tap + to start one.',
    'سنجاق‌شده': 'Pinned',
    'بی‌صدا': 'Muted',
    'بایگانی‌شده': 'Archived',
    '📌 برداشتن سنجاق': '📌 Unpin',
    '📌 سنجاق کردن': '📌 Pin',
    '🔔 روشن کردن صدا': '🔔 Unmute',
    '🔕 بی‌صدا کردن': '🔕 Mute',
    '📤 خارج کردن از بایگانی': '📤 Unarchive',
    '📥 بایگانی کردن': '📥 Archive',
    '🔵 علامت‌زدن به‌عنوان خوانده‌نشده': '🔵 Mark as unread',
    'سنجاق شد.': 'Pinned.',
    'سنجاق برداشته شد.': 'Unpinned.',
    'بی‌صدا شد.': 'Muted.',
    'صدا روشن شد.': 'Unmuted.',
    'بایگانی شد.': 'Archived.',
    'از بایگانی خارج شد.': 'Unarchived.',
    'خوانده‌نشده شد.': 'Marked unread.',
    'این حساب دیگر وجود ندارد': 'This account no longer exists',
    'کاربر حذف‌شده': 'Deleted user',
    'آنلاین': 'online',
    '{n} عضو': '{n} members',
    'آخرین بازدید {when}': 'last seen {when}',
    '{names} در حال نوشتن…': '{names} is typing…',

    /* --- پیام‌ها --- */
    'عکس': 'Photo',
    'فایل': 'File',
    '🖼 عکس': '🖼 Photo',
    '🎤 پیام صوتی': '🎤 Voice message',
    '🖼 عکس فرستاد': 'sent a photo 🖼',
    '🎤 پیام صوتی فرستاد': 'sent a voice message 🎤',
    '📎 {name} فرستاد': 'sent 📎 {name}',
    '{prefix}پیام حذف شد': '{prefix}Message deleted',
    '{prefix}🖼 عکس': '{prefix}🖼 Photo',
    '{prefix}🎤 پیام صوتی': '{prefix}🎤 Voice message',
    '{prefix}📎 {name}': '{prefix}📎 {name}',
    'پیام حذف شد': 'Message deleted',
    'این پیام حذف شد': 'This message was deleted',
    '(ویرایش‌شده)': '(edited)',
    '↪ بازفرستاده‌شده': '↪ Forwarded',
    'واکنش': 'React',
    'برداشتن واکنش': 'Remove reaction',
    'همین واکنش': 'Your reaction',
    'کپی متن': 'Copy text',
    'متن کپی شد.': 'Text copied.',
    'کپی ممکن نشد.': 'Could not copy.',
    'متن‌ها کپی شدند.': 'Texts copied.',
    'متنی برای کپی نیست.': 'Nothing to copy.',
    'انتخاب': 'Select',
    'بازفرستادن': 'Forward',
    'بازفرستادن به…': 'Forward to…',
    'به «{title}» فرستاده شد.': 'Sent to “{title}”.',
    'پاسخ': 'Reply',
    'ویرایش': 'Edit',
    'حذف': 'Delete',
    'ویرایش پیام': 'Edit message',
    'این پیام حذف شود؟': 'Delete this message?',
    'فقط پیام‌های خودتان قابل حذف‌اند.': 'You can only delete your own messages.',
    '{n} پیام انتخاب شده': '{n} selected',
    '{n} پیام حذف شود؟': 'Delete {n} messages?',
    '{n} پیام حذف شد.': '{n} messages deleted.',
    '{n} پیام حذف نشد.': '{n} messages could not be deleted.',
    '{n} پیام پیدا شد': '{n} messages found',
    'در حال ارسال': 'Sending',
    'ارسال شد': 'Sent',
    'خوانده شد': 'Read',
    'پیام بنویسید…': 'Write a message…',
    'در حال بارگذاری…': 'Loading…',

    /* --- عکس، فایل، صدا --- */
    'پیوست': 'Attach',
    'می‌توانید چند عکس را با هم انتخاب کنید': 'You can pick several photos at once',
    'تا {size} — سند، ویدیو، فایل فشرده': 'Up to {size} — documents, video, archives',
    'فقط فایل عکس قابل ارسال است.': 'Only image files can be sent.',
    'توضیح عکس (اختیاری)…': 'Photo caption (optional)…',
    'آماده‌سازی عکس ناموفق بود.': 'Preparing the photo failed.',
    'آماده‌سازی عکس ممکن نشد.': 'Could not prepare the photo.',
    'این فایل عکس نیست.': 'That file is not an image.',
    'در حال ارسال عکس…': 'Sending photo…',
    'در حال ارسال {n} عکس…': 'Sending {n} photos…',
    'حجم فایل بیشتر از {size} است.': 'The file is larger than {size}.',
    'در حال فرستادن {name}…': 'Sending {name}…',
    'پخش پیام صوتی': 'Play voice message',
    'پخش صدا ممکن نشد.': 'Could not play the audio.',
    'مرورگر شما ضبط صدا را پشتیبانی نمی‌کند.': 'Your browser does not support audio recording.',
    'اجازه‌ی دسترسی به میکروفون داده نشد.': 'Microphone access was denied.',

    /* --- اتصال --- */
    'قطع — تلاش برای اتصال…': 'Offline — reconnecting…',
    'ارتباط قطع شد': 'Connection lost',
    'ارتباط با سرور برقرار نیست.': 'No connection to the server.',
    'در حال اتصال…': 'Connecting…',
    'داده‌های هفتگی پاک شد.': 'Weekly data was cleared.',
    '، ': ', ',

    /* --- اعلان --- */
    'اعلان‌ها از قبل فعال است.': 'Notifications are already on.',
    'اعلان‌ها را در تنظیمات مرورگر برای این سایت اجازه دهید.':
      'Allow notifications for this site in your browser settings.',
    'اعلان‌ها فعال شد.': 'Notifications enabled.',
    'اعلان‌ها فعال نشد.': 'Notifications were not enabled.',
    '🔔 فعال‌سازی اعلان‌ها': '🔔 Enable notifications',

    /* --- تماس --- */
    'تماس صوتی': 'Voice call',
    'تماس تصویری': 'Video call',
    'تماس صوتی روی این سرور فعال نیست.': 'Calling is not enabled on this server.',
    'تماس صوتی فقط در گفتگوی دونفره ممکن است.': 'Calls are only possible in one-to-one chats.',
    'اجازه‌ی این تماس را ندارید.': 'You are not allowed to make this call.',
    'تماس‌های زیادی گرفته‌اید؛ کمی بعد دوباره تلاش کنید.': 'Too many calls; try again shortly.',
    'طرف مقابل پیدا نشد.': 'The other person was not found.',
    'همین حالا در یک تماس هستید.': 'You are already in a call.',
    'طرف مقابل در تماس دیگری است.': 'The other person is on another call.',
    'طرف مقابل آنلاین نیست.': 'The other person is not online.',
    'طرف مقابل آنلاین نیست': 'The other person is not online',
    'این تماس دیگر برقرار نیست.': 'This call is no longer active.',
    'تماس پایان یافت': 'Call ended',
    'تماس برقرار نشد': 'Call failed',
    'تماس رد شد': 'Call declined',
    'پاسخی داده نشد': 'No answer',
    'تماس لغو شد': 'Call cancelled',
    'برقراری تماس ممکن نشد': 'Could not place the call',
    '{what} رد شد': '{what} declined',
    '{what} را رد کردید': 'You declined {what}',
    '{what} بی‌پاسخ': '{what} unanswered',
    'دوربین در دسترس نیست؛ تماس فقط صوتی برقرار می‌شود.': 'No camera available; placing a voice call.',
    'مرورگر شما تماس را پشتیبانی نمی‌کند.': 'Your browser does not support calls.',
    'در حال زنگ زدن…': 'Ringing…',
    'دسترسی به میکروفون داده نشد.': 'Microphone access was denied.',
    'بی‌صدا کردن میکروفون': 'Mute microphone',
    'روشن کردن میکروفون': 'Unmute microphone',
    'میکروفون روشن شد.': 'Microphone on.',
    'میکروفون بی‌صدا شد.': 'Microphone muted.',
    'خاموش کردن دوربین': 'Turn camera off',
    'روشن کردن دوربین': 'Turn camera on',
    'دوربین دیگری پیدا نشد.': 'No other camera found.',
    'کاربر': 'User',
    'تماس تصویری ورودی…': 'Incoming video call…',
    'تماس صوتی ورودی…': 'Incoming voice call…',
    'تماس تصویری…': 'Video call…',
    'تماس صوتی…': 'Voice call…',

    /* --- شناسه و گفتگوی تازه --- */
    'دیگران با همین شناسه شما را پیدا می‌کنند.': 'This is how others find you.',
    'کپی': 'Copy',
    'شناسه کپی شد.': 'Username copied.',
    'کپی ممکن نشد؛ دستی انتخابش کنید.': 'Could not copy; select it by hand.',
    'اشتراک‌گذاری': 'Share',
    'شناسه‌ی من در 9chat: @{username}': 'My 9chat username: @{username}',
    'گفتگوی جدید': 'New chat',
    'گفتگویی برای بازفرستادن نیست.': 'No chat to forward to.',
    'کاربری با این نام کاربری پیدا نشد. نام کاربری باید دقیق باشد.':
      'No user with that username. It has to match exactly.',
    'نام کاربری دقیق طرف مقابل…': 'Exact username…',
    'برای شروع گفتگو باید نام کاربری دقیق طرف مقابل را بدانید.':
      'To start a chat you need the exact username.',
    '👥 ساخت گروه جدید': '👥 Create a group',
    'گروه جدید': 'New group',
    'نام گروه': 'Group name',
    'نام کاربری دقیق عضو تازه…': 'Exact username of a new member…',
    'هنوز عضوی انتخاب نشده است.': 'No members selected yet.',
    'اعضا: {names}': 'Members: {names}',
    'ساخت گروه': 'Create group',
    'نام گروه را بنویسید.': 'Enter a group name.',
    'حداقل یک عضو انتخاب کنید.': 'Pick at least one member.',

    /* --- عکس پروفایل --- */
    'حذف عکس': 'Remove photo',
    'تغییر عکس': 'Change photo',
    'انتخاب عکس': 'Choose a photo',
    'عکس پروفایل به‌روز شد.': 'Profile photo updated.',
    'عکس پروفایل حذف شد.': 'Profile photo removed.',
    'تغییر عکس گروه': 'Change group photo',
    'انتخاب عکس گروه': 'Choose a group photo',
    'عکس گروه به‌روز شد.': 'Group photo updated.',
    'عکس گروه حذف شد.': 'Group photo removed.',

    /* --- دستگاه‌ها --- */
    'دستگاه ناشناس': 'Unknown device',
    'اندروید': 'Android',
    'ویندوز': 'Windows',
    'مک': 'Mac',
    'لینوکس': 'Linux',
    'نامشخص': 'unknown',
    'فایرفاکس': 'Firefox',
    'اج': 'Edge',
    'کروم': 'Chrome',
    'سافاری': 'Safari',
    'مرورگر': 'Browser',
    '{browser} روی {platform}': '{browser} on {platform}',
    'بستن همه‌ی دستگاه‌های دیگر': 'Sign out all other devices',
    'همین دستگاه': 'this device',
    'آخرین فعالیت {when}': 'last active {when}',
    'بستن': 'Close',
    'دستگاه بسته شد.': 'Device signed out.',
    '{n} دستگاه بسته شد.': '{n} devices signed out.',
    'همه‌ی دستگاه‌های دیگر از حساب خارج شوند؟': 'Sign out all other devices?',

    /* --- بلاک --- */
    'کسی را بلاک نکرده‌اید.': 'You have not blocked anyone.',
    'رفع بلاک': 'Unblock',
    'رفع بلاک شد.': 'Unblocked.',
    '🚫 بلاک کردن این کاربر': '🚫 Block this user',
    '{name} بلاک شود؟ دیگر نمی‌توانید به هم پیام بدهید.':
      'Block {name}? Neither of you will be able to message the other.',
    'کاربر بلاک شد. از پروفایل می‌توانید رفع بلاکش کنید.':
      'User blocked. You can unblock them from your profile.',

    /* --- نسخه --- */
    'نسخه‌ی وب': 'Web version',
    'اپ اندروید': 'Android app',
    'نسخه‌ی وب: {version} ({built})': 'Web version: {version} ({built})',
    'اپ اندروید: {version}': 'Android app: {version}',
    'APK روی سرور: {version}': 'APK on server: {version}',
    'نسخه‌ی اپ را اینجا نشان نمی‌دهد چون نسخه‌ی نصب‌شده قدیمی‌تر از ۱.۴ است؛ ':
      'The installed app is older than 1.4, so its version is not shown here; ',
    'از تنظیمات گوشی ← برنامه‌ها ← 9chat ببینیدش.': 'check Settings → Apps → 9chat on your phone.',
    'کپی اطلاعات نسخه': 'Copy version info',
    'اطلاعات نسخه کپی شد.': 'Version info copied.',
    'نسخه‌ی تازه‌ای از برنامه آمده است.': 'A new version of the app is available.',
    'نسخه‌ی {version} اپ اندروید آمده است (شما {installed} دارید).':
      'Android app {version} is out (you have {installed}).',
    'تازه‌سازی': 'Refresh',
    'دریافت': 'Download',

    /* --- پروفایل --- */
    'پروفایل': 'Profile',
    'درباره من': 'About me',
    'درباره‌ی من': 'About me',
    'ذخیره': 'Save',
    'پروفایل به‌روز شد.': 'Profile updated.',
    'نام نمایشی': 'Display name',
    'همین نامی که دیگران می‌بینند.': 'This is the name others see.',
    'رمز فعلی': 'Current password',
    'رمز تازه': 'New password',
    'رمز تازه (حداقل ۸ نویسه)': 'New password (at least 8 characters)',
    'حداقل ۸ نویسه.': 'At least 8 characters.',
    'تغییر رمز': 'Change password',
    'تغییر رمز عبور': 'Change password',
    'هر دو رمز را پر کنید.': 'Fill in both passwords.',
    'خروج از حساب': 'Sign out',
    'دستگاه‌های واردشده': 'Signed-in devices',
    'کاربران بلاک‌شده': 'Blocked users',
    'سایر': 'Other',
    'درباره‌ی برنامه': 'About this app',

    /* --- گروه و گفتگو --- */
    'ذخیره‌ی نام': 'Save name',
    'نام گروه خالی است.': 'The group name is empty.',
    'نام گروه به‌روز شد.': 'Group name updated.',
    'اطلاعات گروه': 'Group info',
    'اطلاعات مخاطب': 'Contact info',
    'حساب طرف مقابل حذف شده است. می‌توانید این گفتگو را از فهرست خود پاک کنید.':
      'The other account has been deleted. You can remove this chat from your list.',
    '🗑 حذف گفتگو (فقط برای من)': '🗑 Delete chat (only for me)',
    'این گفتگو از فهرست شما پاک شود؟ طرف مقابل نسخه‌ی خودش را خواهد داشت.':
      'Remove this chat from your list? The other person keeps their copy.',
    'گفتگو پاک شد.': 'Chat removed.',
    'اعضا': 'Members',
    ' — سازنده': ' — owner',
    ' — مدیر گروه': ' — group admin',
    'مدیر گروه': 'Group admin',
    'برداشتن مدیریت': 'Remove admin',
    'نقش عضو به‌روز شد.': 'Member role updated.',
    'حذف از گروه': 'Remove from group',
    'حذف {name} از گروه': 'Remove {name} from the group',
    '{name} از گروه حذف شود؟': 'Remove {name} from the group?',
    'عضو حذف شد.': 'Member removed.',
    '➕ افزودن عضو': '➕ Add member',
    'افزودن عضو': 'Add member',
    'نام کاربری دقیق…': 'Exact username…',
    'عضو اضافه شد.': 'Member added.',
    'خروج از گروه': 'Leave group',
    'از این گروه خارج می‌شوید؟': 'Leave this group?',

    /* --- استوری و ایموجی --- */
    'ایموجی': 'Emoji',
    'گفتگو': 'Chat',
    'استوری من': 'My story',
    'افزودن': 'Add',
    '👁 هنوز کسی ندیده': '👁 No views yet',
    '👁 {n} بیننده': '👁 {n} viewers',
    'بیننده‌های استوری': 'Story viewers',
    'این استوری حذف شود؟': 'Delete this story?',
    'استوری حذف شد.': 'Story deleted.',
    'استوری شما تا ۲۴ ساعت دیده می‌شود.': 'Your story stays up for 24 hours.',
    'فرستادن استوری ناموفق بود.': 'Posting the story failed.',

    /* --- index.html --- */
    'گفتگو و ارسال عکس، ساده و سریع': 'Chat and photos, simple and fast',
    'ورود': 'Sign in',
    'ثبت‌نام': 'Sign up',
    'نام کاربری': 'Username',
    'رمز عبور': 'Password',
    'رمزم را فراموش کرده‌ام': 'I forgot my password',
    'پس از ثبت‌نام، حساب شما باید توسط مدیر تایید شود.':
      'After signing up, an admin has to approve your account.',
    'دریافت برنامه‌ی اندروید': 'Get the Android app',
    'گفتگویی باز نیست': 'No chat open',
    'از فهرست کنار صفحه یکی را باز کنید، یا با دکمه‌ی ＋ گفتگوی تازه‌ای بسازید.':
      'Open one from the list, or tap ＋ to start a new chat.',
    'پاسخ به': 'Replying to',
    '۰:۰۰': '0:00',
    'در حال ضبط…': 'Recording…',
    'نام شما': 'Your name',
    'فقط حروف انگلیسی، عدد و _': 'Latin letters, digits and _ only',
    'حداقل ۸ نویسه': 'At least 8 characters',
    'پنل مدیریت': 'Admin panel',
    'تنظیم ظاهر: تم، رنگ و پس‌زمینه': 'Appearance: theme, color and background',
    'جستجو در گفتگوها…': 'Search chats…',
    'بازگشت': 'Back',
    'اطلاعات گفتگو': 'Chat info',
    'لغو انتخاب': 'Cancel selection',
    'رفتن به آخرین پیام': 'Jump to latest message',
    'لغو پاسخ': 'Cancel reply',
    'لغو ضبط': 'Cancel recording',
    'ارسال پیام صوتی': 'Send voice message',
    'پیوست عکس یا فایل': 'Attach a photo or file',
    'افزودن ایموجی': 'Add emoji',
    'پیام صوتی': 'Voice message',
    'ضبط پیام صوتی': 'Record a voice message',
    'ارسال': 'Send',
    'استوری': 'Story',
    'حذف استوری': 'Delete story',
    'قبلی': 'Previous',
    'بعدی': 'Next',
    'دانلود': 'Download',
    'تعویض دوربین جلو و عقب': 'Switch front/back camera',
    'پایان تماس': 'End call',
    'پیام‌ها و عکس‌ها به‌صورت دوره‌ای پاک می‌شوند':
      'Messages and photos are cleared from time to time',
  };

  const DICT = { fa: null, en: EN };

  const stored = () => {
    try {
      return localStorage.getItem(LANG_KEY);
    } catch {
      return null;
    }
  };

  /* پیش‌فرض فارسی است. انتخاب خودِ کاربر همیشه مقدم است. */
  const DEFAULT_LANG = 'fa';

  const detect = () => {
    const saved = stored();
    return saved && DICT[saved] !== undefined ? saved : DEFAULT_LANG;
  };

  let lang = detect();
  const dirOf = (code) => (LANGS.find(([id]) => id === code) || LANGS[0])[2];

  /**
   * ترجمه. اگر ترجمه‌ای نبود، خودِ متن فارسی برمی‌گردد — کاربر هیچ‌وقت
   * کلید خام نمی‌بیند.
   */
  function t(key, vars) {
    const table = DICT[lang];
    let out = (table && table[key]) || key;
    if (vars) {
      for (const [name, value] of Object.entries(vars)) {
        out = out.split(`{${name}}`).join(String(value));
      }
    }
    return out;
  }

  /** عدد: فارسی با رقم فارسی، انگلیسی با رقم لاتین. */
  const num = (n) => Number(n).toLocaleString(lang === 'fa' ? 'fa-IR' : 'en-US');
  const localeOf = () => (lang === 'fa' ? 'fa-IR' : 'en-GB');

  /**
   * متن‌های ثابتِ index.html. به‌جای برچسب‌گذاری تک‌تک عنصرها، یک‌بار کل
   * صفحه پیموده می‌شود: کلیدها همان متن فارسیِ داخل فایل‌اند، پس چیزی
   * برای از قلم افتادن نمی‌ماند.
   */
  function translateDom(root = document) {
    if (lang === 'fa') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const node of texts) {
      const key = node.nodeValue.trim();
      if (!key) continue;
      const hit = EN[key];
      if (hit) node.nodeValue = node.nodeValue.replace(key, hit);
    }
    for (const attr of ['placeholder', 'title', 'aria-label', 'value']) {
      for (const el of root.querySelectorAll(`[${attr}]`)) {
        const hit = EN[el.getAttribute(attr)];
        if (hit) el.setAttribute(attr, hit);
      }
    }
  }

  function applyLang() {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = dirOf(lang);
  }

  /** عوض کردن زبان صفحه را از نو بار می‌کند: تنها راه مطمئن برای اینکه
      هیچ متنی از زبان قبلی جا نماند. */
  function setLang(code) {
    if (!DICT[code] && code !== 'fa') return;
    try {
      localStorage.setItem(LANG_KEY, code);
    } catch {
      /* حالت خصوصی مرورگر: دست‌کم همین نشست عوض می‌شود */
    }
    lang = code;
    location.reload();
  }

  applyLang();

  /* این فایل در <head> و به‌صورت مسدودکننده بار می‌شود، پس lang و dir پیش از
     کشیده شدن بدنه ست می‌شوند و صفحه یک‌بار راست‌چینِ فارسی ظاهر نمی‌شود تا
     بعد بپرد. متن‌های ثابت هم به‌محض آماده شدن DOM ترجمه می‌شوند. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => translateDom(), { once: true });
  } else {
    translateDom();
  }

  window.i18n = {
    t,
    num,
    localeOf,
    translateDom,
    setLang,
    langs: LANGS,
    get current() {
      return lang;
    },
  };
})();
