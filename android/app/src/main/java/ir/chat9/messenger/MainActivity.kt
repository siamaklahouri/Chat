package ir.chat9.messenger

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.view.View
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import ir.chat9.messenger.databinding.ActivityMainBinding
import java.io.File

/**
 * پوسته‌ی اندرویدی پیام‌رسان: وب‌اپ را در یک WebView تمام‌صفحه نشان می‌دهد و
 * کارهایی را که وب به‌تنهایی نمی‌تواند انجام دهد (انتخاب عکس از گالری و دوربین،
 * دکمه‌ی بازگشت، کشیدن برای تازه‌سازی) به سیستم‌عامل وصل می‌کند.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var cameraImageUri: Uri? = null
    private var pendingMediaRequest: PermissionRequest? = null
    private var loadFailed = false

    private val prefs by lazy { getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    private val serverUrl: String
        get() = prefs.getString(KEY_SERVER, BuildConfig.DEFAULT_SERVER_URL) ?: BuildConfig.DEFAULT_SERVER_URL

    /** نتیجه‌ی انتخاب عکس (گالری یا دوربین) را به WebView برمی‌گرداند. */
    private val fileChooserLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val callback = filePathCallback ?: return@registerForActivityResult
            filePathCallback = null

            val uris: Array<Uri>? = when {
                result.resultCode != RESULT_OK -> null
                result.data?.data != null -> arrayOf(result.data!!.data!!)
                result.data?.clipData != null -> {
                    val clip = result.data!!.clipData!!
                    Array(clip.itemCount) { clip.getItemAt(it).uri }
                }
                cameraImageUri != null -> arrayOf(cameraImageUri!!)
                else -> null
            }
            callback.onReceiveValue(uris)
            cameraImageUri = null
        }

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (!granted) toast(getString(R.string.notification_permission_needed))
        }

    private val mediaPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { results ->
            val request = pendingMediaRequest
            pendingMediaRequest = null
            if (results.values.all { it }) {
                request?.grant(request.resources)
            } else {
                request?.deny()
                toast(getString(R.string.media_permission_needed))
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setUpWebView()
        binding.swipeRefresh.setOnRefreshListener { binding.webView.reload() }
        binding.retryButton.setOnClickListener { loadApp() }
        binding.serverButton.setOnClickListener { askForServerUrl() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (binding.webView.canGoBack()) binding.webView.goBack() else finish()
            }
        })

        if (savedInstanceState != null) {
            binding.webView.restoreState(savedInstanceState)
        } else if (prefs.getString(KEY_SERVER, null) == null) {
            askForServerUrl()
        } else {
            loadApp()
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() = with(binding.webView) {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            cacheMode = WebSettings.LOAD_DEFAULT
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }
        setBackgroundColor(ContextCompat.getColor(this@MainActivity, R.color.background))

        // پل اعلان؛ فقط برای صفحه‌هایی از سرور خودمان فعال است.
        addJavascriptInterface(
            WebAppBridge(
                context = this@MainActivity,
                isTrustedPage = { url?.startsWith(serverUrl) == true },
                onPermissionNeeded = { ensureNotificationPermission() }
            ),
            "AndroidBridge"
        )

        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                // پیوندهای بیرونی در مرورگر سیستم باز می‌شوند.
                if (!url.startsWith(serverUrl)) {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                    return true
                }
                return false
            }

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                loadFailed = false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                binding.swipeRefresh.isRefreshing = false
                if (!loadFailed) showError(false)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError
            ) {
                if (!request.isForMainFrame) return
                loadFailed = true
                binding.swipeRefresh.isRefreshing = false
                showError(true)
            }
        }

        webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                return openImagePicker(params)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                // صفحه برای ضبط پیام صوتی میکروفون می‌خواهد و برای گرفتن عکس دوربین.
                val wantsAudio = request.resources.any { it == PermissionRequest.RESOURCE_AUDIO_CAPTURE }
                val wantsVideo = request.resources.any { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }

                val needed = buildList {
                    if (wantsAudio && !hasPermission(Manifest.permission.RECORD_AUDIO)) add(Manifest.permission.RECORD_AUDIO)
                    if (wantsVideo && !hasPermission(Manifest.permission.CAMERA)) add(Manifest.permission.CAMERA)
                }

                when {
                    !wantsAudio && !wantsVideo -> request.deny()
                    needed.isEmpty() -> request.grant(request.resources)
                    else -> {
                        pendingMediaRequest = request
                        mediaPermissionLauncher.launch(needed.toTypedArray())
                    }
                }
            }
        }
    }

    /** انتخاب‌گر عکس: گالری به‌همراه دوربین در یک پنجره. */
    private fun openImagePicker(params: WebChromeClient.FileChooserParams): Boolean {
        val galleryIntent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
            putExtra(
                Intent.EXTRA_ALLOW_MULTIPLE,
                params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE
            )
        }

        val chooser = Intent.createChooser(galleryIntent, params.title ?: "انتخاب عکس")
        if (hasCameraPermission()) {
            cameraIntent()?.let { chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(it)) }
        }

        return runCatching { fileChooserLauncher.launch(chooser) }.isSuccess.also { started ->
            if (!started) {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = null
            }
        }
    }

    private fun cameraIntent(): Intent? = runCatching {
        val dir = File(cacheDir, "camera").apply { mkdirs() }
        val photo = File(dir, "shot-${System.currentTimeMillis()}.jpg")
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", photo)
        cameraImageUri = uri
        Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, uri)
            addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }.getOrNull()

    /** در اندروید ۱۳ به بالا، اعلان اجازه‌ی جداگانه می‌خواهد. */
    private fun ensureNotificationPermission() {
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            toast(getString(R.string.notification_permission_needed))
        }
    }

    private fun hasPermission(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun hasCameraPermission() = hasPermission(Manifest.permission.CAMERA)

    private fun loadApp() {
        showError(false)
        binding.webView.loadUrl(serverUrl)
    }

    private fun showError(visible: Boolean) {
        binding.errorView.visibility = if (visible) View.VISIBLE else View.GONE
        binding.swipeRefresh.visibility = if (visible) View.GONE else View.VISIBLE
    }

    private fun askForServerUrl() {
        val input = EditText(this).apply {
            setText(serverUrl)
            setSelection(text.length)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.server_dialog_title)
            .setMessage(R.string.server_dialog_message)
            .setView(input)
            .setPositiveButton(R.string.save) { _, _ ->
                val url = input.text.toString().trim().trimEnd('/')
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    prefs.edit().putString(KEY_SERVER, url).apply()
                    loadApp()
                } else {
                    toast("نشانی باید با http:// یا https:// شروع شود.")
                    askForServerUrl()
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .setCancelable(prefs.getString(KEY_SERVER, null) != null)
            .show()
    }

    private fun toast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webView.saveState(outState)
    }

    private companion object {
        const val PREFS = "messenger-prefs"
        const val KEY_SERVER = "server-url"
    }
}
