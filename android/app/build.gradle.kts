import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// امضای نسخه‌ی release از فایل keystore.properties خوانده می‌شود (در گیت نیست).
// نمونه‌ی محتوای آن در keystore.properties.example هست.
val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

android {
    namespace = "ir.chat9.messenger"
    compileSdk = 34

    defaultConfig {
        applicationId = "ir.chat9.messenger"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // نشانی پیش‌فرض سرور. کاربر می‌تواند در خود برنامه عوضش کند — مثلاً
        // برای وصل شدن به یک سرور محلی وقتی اینترنت در دسترس نیست.
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://9chat.ir\"")
    }

    signingConfigs {
        if (keystoreProperties.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildFeatures {
        buildConfig = true
        viewBinding = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // اگر keystore تعریف شده باشد نسخه‌ی release با آن امضا می‌شود،
            // وگرنه بیلد release بدون امضا ساخته می‌شود.
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.activity:activity-ktx:1.9.1")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("com.google.android.material:material:1.12.0")
    // برای اتصال دائمی سرویس پس‌زمینه به سرور خودمان (بدون هیچ سرویس گوگلی)
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
