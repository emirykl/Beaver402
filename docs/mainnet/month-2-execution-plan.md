# Beaver402 — 2. ay teslim planı

**Sürüm:** 2026-10-02 çalışma tabanı · **Sahip:** Emir Yenikale · **Kapsam:** Instawards ikinci ay D1, D2, D3 ve Customer Development Plan · **Durum:** uygulama sürüyor

Bu belge ikinci ay için çalışma ve teslimat kaydıdır. Kaynak kapsam, `2026.08.20_Instawards SOW - Emir Yenikale 2nd Month (2).pdf` ile `2026.08.19_Instawards Customer Development Plan - Beaver402 (2).pdf` dosyalarının doldurulmuş sürümleridir. Önceki `Beaver402 - 2. Ay Uygulama Planı.pdf` tasarım ve iş envanteri olarak kullanılmıştır. Bu belgede bir iş, yalnızca **kabul koşulu** sağlanıp **kanıtı** bağlandığında tamamlanır. Kodun yazılması tek başına teslimat sayılmaz.

## 0. Çalışma kuralları ve mevcut durum

### İlerleme kaydı

Her iş için `bekliyor → sürüyor → doğrulandı` kullanılır. `Doğrulandı` durumuna tarih, kaynak commit'i, test/işlem sonucu ve kanıt bağlantısı eklenir. Ağ üstündeki gerçek bir sonuç yerel testle ikame edilmez. Her faz sonunda bu belgedeki durum, [hazırlık listesi](readiness-checklist.md), [risk kaydı](risk-register.md) ve [kanıt dizini](../evidence.md) birlikte güncellenir. Claude ile Codex aynı çalışma ağacını gördüğü için uygulama sırasında dosya sahipliği faz bazında ayrılır; kaydedilmemiş değişiklikler silinmez veya üstüne yazılmaz. Bir görev başlamadan önce `git status` ve ilgili son commit incelenir.

**2 Ekim repo kontrolünden görülenler:** Kontrat sertleştirme, ağ ayrımı, x402 v2 akışı, CI, operasyon görünümü ve landing kodunun önemli kısmı işlenmiş. [Barındırılan facilitator provası](../operations/rehearsals/2026-10-02-testnet-hosted.md) testnet'te MCP ödemesi, PoI, ret, dondurma, kurtarma ve göç adımlarını gösteriyor; [önceki prova](../operations/rehearsals/2026-10-02-testnet-reference.md) yerel referans uygulamayı kullanmıştı. [x402 uyumluluk kaydı](x402-compat.md) ve [hazırlık listesi](readiness-checklist.md) Kapı 1'in geçtiğini gösteriyor. Dış inceleme, release etiketi, Vercel üzerinde gerçek passkey provası ve üretim kimlikleri henüz kanıtlanmamış. Bu gözlem tamamlanmışlık iddiası değildir; Claude'un devam eden değişiklikleriyle tekrar ölçülür.

**Supabase:** Ana mainnet projesi ve migration çalıştırılması kullanıcı tarafından bildirildi. Hangi SQL dosyalarının hangi projede uygulandığı salt okunur şema/izin sorgularıyla doğrulanmadan `doğrulandı` yazılmaz. `supabase/migrations/20260930000000_mainnet_baseline.sql` ile `scripts/supabase-migration.sql`, `scripts/supabase-migration-002.sql` ve `scripts/supabase-migration-003.sql` yaklaşımı arasında tek sürümlü şema kaydı oluşturulur; aynı tabloları yeniden yaratacak CLI push çalıştırılmaz. Özellikle `page_metrics`, `chain_events`, `collector_state` ve RLS/anon izinleri kontrol edilir. [Supabase notu](supabase.md) ile [işletim rehberindeki](../operations/operating-guide.md) migration sırası uzlaştırılır.

**Değişken bilgiler:** PDF'de protokol 29, Stellar'ın yayınlanmış [sürüm sayfasında](https://developers.stellar.org/docs/networks/software-versions) mainnet için 28 görünüyor; 2 Ekim'deki [canlı testnet RPC sorgusu](verification-2026-10-02.md) testnet protokolünü 29 bildirdi. Bu üç gözlem deploy anındaki **mainnet** sürümünü kanıtlamaz. Her ağ için doğrudan RPC `getVersionInfo` ve `getNetwork` çıktısı, CLI/SDK sürümleri ve facilitator `/supported` cevabı kapı dosyasına tarihli olarak yazılır. Ağ, asset ve ücret limitleri eski PDF değerlerinden sessizce devralınmaz.

### Değişmez kapsam ve bütçe

- Yalnızca **bir referans merchant**, **bir resmi mainnet USDC SAC**, builder'ın kendi fonu ve kontrollü pilot.
- Kontrat ödeme başına en çok **1 USDC**; kayan 24 saatte en çok **5 ödeme ve 5 USDC** uygular. Bu limitler pilot boyunca yalnızca azaltılabilir. Kontratın zorlayamadığı **10 USDC azami bakiye** fonlama öncesi ve sonra ölçülen operasyon kuralıdır; başlangıç fonu 5 USDC hedeflenir.
- Merchant, yalnızca doğruladığı başarılı settlement sonrasında içerik verir. Proof of Intent, settlement ile ortak nonce/challenge hash üzerinden bağlanan ayrı zincir işlemidir.
- Anahtar, WebAuthn assertion, imza, özel istek gövdesi, Supabase service key veya API token kanıta, ekrana, repoya ve modele konmaz. Kanıtta açık kimlikler ve işlem hash'leri kullanılabilir.
- Kapsam dışında: sınırsız lansman, çoklu merchant, müşteri fonu saklama, yeni facilitator/cüzdan/protokol, resmi audit, cihaz kurtarma, gelişmiş alarm, mobil uygulama. Dış **peer review** zorunludur; resmi audit değildir.

## 1. Faz ve kapı haritası

| Sıra | Faz | Çıktı | Kapı / ilerleme koşulu |
|---|---|---|---|
| 0 | Kapsam, ortam ve kanıt tabanı | doğrulanmış durum tablosu, proje/şema/rol ayrımı | kaynak SOW ve şema uyuşuyor |
| 1 | D1 kontrat ve ağ güvenliği | test edilmiş immutable kontrat, yapılandırma | güvenlik değişmezleri ve testler geçiyor |
| 2 | D1 x402 ve testnet | barındırılan facilitator ile MCP testnet ödemesi | **Kapı 1** |
| 3 | D1 release ve dış inceleme | incelenmiş artifact, temiz CI, peer review | **Kapı 2** |
| 4 | D3 barındırma ve operasyon hazırlığı | canlıya yakın testnet prova, landing önizleme, collector | üretim topolojisi ve prosedürler prova edildi |
| 5 | D2 mainnet kararı ve kurulum | tarihli go kararı, ayrılmış roller, deploy | **Kapı 3**, sonra sınırlı mainnet işlemleri |
| 6 | D2 ödeme ve kontroller | zincirde settlement/proof ve owner kontrolleri | D2 kanıt paketi eksiksiz |
| 7 | D3 kullanıcı çalışması ve olay provası | iki değerlendirme, kayıt, hipotezler, kurtarma | D3 kanıt paketi eksiksiz |
| 8 | Teslim ve bağımsız doğrulama | linkli kanıt indeksi, rapor, demo, `v0.2.0` | D1–D3 kontrol listesi tam |

Fazlar numara sırasındadır; Faz 4'ün sayfa içeriği ve Faz 7'nin ilk görüşme hazırlığı, güvenli olduğu ölçüde önceki fazlarla paralel yürüyebilir. **Kapı 1 ve 2 geçmeden Kapı 3 kararı verilemez. Kapı 3 verilmeden mainnet'e kontrat deploy/fonlama/ödeme yapılmaz.** Her kapı `geçti / geçmedi`, tarih, kararı veren kişi, gerekçe ve linkli kanıtla kaydedilir. `Geçmedi` sonucunda bekleyen işi çöz ve ilgili test/provayı yeniden çalıştır; kapı atlanmaz.

### İlk uygulama sırası — 2 Ekim başlangıcı

| Öncelik | Şu an görülen durum | Sonraki ölçülebilir adım |
|---|---|---|
| 1 | Kod ve yerel testnet prova var; Claude'un çalışması sürüyor | Güncel commit/CI/test ve Supabase şema envanterini çıkar, bu tablonun tarihini güncelle. |
| 2 | Kapı 1: hosted facilitator ile MCP testnet ödemesi ve PoI geçti | [Hosted prova](../operations/rehearsals/2026-10-02-testnet-hosted.md) ve [uyumluluk kaydı](x402-compat.md) üzerinden işlem çiftini teslim indeksine bağla. |
| 3 | Release altyapısı var; dış inceleme kaydı yok | Aynı source commit ve artifact üzerinde CI, hash tekrarı ve bağımsız peer review tamamla. |
| 4 | Yerel referans facilitator ile tam prova var | Üç Vercel projesinde hosted testnet akışını ve Supabase collector'ı yeniden prova et. |
| 5 | Mainnet ve kullanıcı kanıtları henüz yok | Kapı 3 sonrası sınırlı deploy/ödeme; iki oturum ve final kanıt paketi. |

### Kanıt kontrolü — 2 Ekim 2026, yerel taban `895db7b`, gizlilik düzeltmesi `bc3fcb8`

`[x]` yalnızca yanındaki **sınırlı iddianın** kanıtlandığını gösterir; ilgili fazın veya D1–D3 teslimatının tümü bitti anlamına gelmez. `895db7b` tabanında `cargo test -q` **75/75**, backend `npm test -- --run` **227/227**, `cargo clippy --all-targets -- -D warnings`, backend `npm run build` ve frontend `npm run build` geçti. `bc3fcb8` sonrasında backend testleri **233/233** ve TypeScript derlemesi geçti. Frontend derlemesinde Vite'ın gelecekteki native config loader'ı için uyarı var; derleme hatası değil. Bunlar yerel sonuçlardır; son release commit'i için CI ve hosted ağ kanıtları ayrıca istenir.

**Tamamlanan, kanıtı görülen alt işler**

- [x] **0.1 kapsam eşlemesi:** D1–D3 ve müşteri planı bu belgenin teslim tablosuna bağlandı; doldurulmuş kaynak PDF'lerle karşılaştırıldı.
- [x] **1.2 ağ ayrımı kodu/testi:** [ağ yapılandırması](network-config.md), `backend/tests/network-config.test.ts` ve `adapter-network.test.ts` var; backend testleri geçti. Canlı RPC preflight ayrıca açık.
- [x] **1.3–1.5 kontrat güvenlik kodu/testi:** owner/agent yetkileri, passkey kontrolleri, immutable yol, kayan limitler ve donukken sabit adrese kurtarma kontrat testlerinde; [hosted testnet provasında](../operations/rehearsals/2026-10-02-testnet-hosted.md) owner işlemleri ve recovery zincirde.
- [x] **1.6–1.7 TTL, ücret ve proof tasarımı/testi:** [x402 ölçümünde](x402-compat.md) 38.411 stroop kaynak ücret ve yalnız transfer event'i kaydedilmiş; testnet provasında proof ve owner event'leri var. Mainnet simülasyonu yine gerekli.
- [x] **1.8 merchant ve agent güvenlik kodu/testi:** `agent-guard`, `merchant-x402` ve `settlement` testleri backend test koşusunda geçti; provada settlement sonrası korumalı yanıt ve retler kaydedilmiş.
- [x] **1.10 ortak kodlama/hata testleri:** `cross-lang`, `encoding`, `policy-errors` ve istek değişikliği testleri geçti.
- [x] **Kapı 1, hosted facilitator provası:** MCP aracından başlatılan [testnet ödeme işlemi](https://stellar.expert/explorer/testnet/tx/ed40457717d25214420c04a28bb16a14f53b7bfc5e39f0a3cc334ffe1bbefd6e) ile [bağlı proof işlemi](https://stellar.expert/explorer/testnet/tx/37c6b23123a6c11064b2a30cc73f511f919a245d5c4ff053cc11a87fe6d94782) kaydedildi; [hosted prova](../operations/rehearsals/2026-10-02-testnet-hosted.md) ve [uyumluluk kaydı](x402-compat.md) OpenZeppelin Channels akışını gösteriyor.
- [x] **3.1 CI yapılandırması ve yerel temel doğrulama:** [.github/workflows/ci.yml](../../.github/workflows/ci.yml) test, derleme, Clippy ve audit işlerini içeriyor; yukarıdaki yerel test/derlemeler geçti. Release commit'inin CI sonucu ve audit kanıtı açık.
- [x] **0.3 kısmi Supabase şema kontrolü:** [bağımsız doğrulamada](verification-2026-10-02.md) dokuz beklenen tablo service role ile salt okunur erişilebilir ve boş; [migration yolları uzlaştırıldı](migration-reconciliation.md). RLS, anon izinleri ve fonksiyon yetkileri için [SQL Editor sorgusu](supabase-verification.sql) bekleniyor.
- [x] **3.2 kısmi artifact kontrolü:** `stellar contract build` 28.488 byte WASM ve [release kaydındaki](release.md) `963c55c1…6e76d42f` SHA-256 değerini yerelde yeniden üretti; CI artifact eşleşmesi ve tag bekleniyor.
- [x] **Bağımlılık denetimleri, yerel:** backend/frontend üretim `npm audit` sıfır güvenlik açığı; `cargo audit` sıfır güvenlik açığı, bir bilgilendirici bakımı bırakılmış `paste` uyarısı. [Ayrıntı](verification-2026-10-02.md).
- [x] **Faz 4 kısmi HTTP smoke:** [bağımsız doğrulamada](verification-2026-10-02.md) landing, agent, merchant ve frontend API yönlendirmesi testnet'te HTTP 200 verdi. Aynı `/api/status` merchant onayı `false`, collector `null` gösterdi; tam hosted prova açık.
- [x] **Faz 4 scriptli testnet olay/göç provası:** [hosted prova kaydı](../operations/rehearsals/2026-10-02-testnet-hosted.md) freeze, restore, signer revoke, merchant remove, limit düşürme, recovery ve yeni hesaba göç işlemlerini içeriyor. Gerçek cihaz passkey'i + Vercel provası açık.
- [x] **Faz 4 landing, collector ve rehber kodu/taslağı:** `/`, `/panel`, `/status`, collector ve metrik modülleri ile [operasyon rehberleri](../operations/operating-guide.md) repoda; frontend/backend derlemeleri ve ilgili backend testleri geçti. Canlı dağıtım ve veri export'u açık.
- [x] **Faz 5 deploy kayıt şablonu ve ön kontrol kodu:** [deploy kaydı](deployment-record.md) şablonu ve preflight scripti var. Şablondaki mainnet işlem alanları boş; gerçek deploy yapılmadı.

**Kabulü henüz tamamlanmayan işler**

- [ ] **0.2–0.6'nın kalanı:** release CI URL'si, Supabase RLS/anon/fonksiyon izinleri, kalıcı production origin, iki oturum tarihi ve canlı RPC/facilitator sürüm kaydı.
- [ ] **1.1 ve 1.9'un üretim kısmı:** canlı ağ protokolüyle release sürüm uyumu; stateless passkey/rate limit akışının ayrı barındırılan instance'larda çalışması.
- [x] **Kapı 1:** hosted OpenZeppelin facilitator ile MCP testnet ödemesi ve PoI [işlem kanıtıyla](../operations/rehearsals/2026-10-02-testnet-hosted.md) geçti. Gerçek cihaz passkey'i ve Vercel provası ayrı Faz 4 işidir.
- [ ] **Kapı 2:** aynı artifact'ın tekrar üretilebilir hash'i, release commit CI/audit sonucu, dış peer review, kapanmış yüksek/kritik bulgular, `v0.2.0-rc.N`.
- [x] **I14 gizlilik bulgusu:** `bc3fcb8` ile `/api/transactions` owner oturumuna bağlandı; yerel test geçti, yayındaki testnet agent oturumsuz isteğe HTTP 401 döndü. [Bulgu](../security/findings.md) kapandı; mainnet hosted kontrolü ayrıca yapılacak.
- [ ] **I15 gizlilik bulgusu:** yeni collector hata yazıları sabit özet olsa da mevcut veritabanı satırındaki ham `last_error` public `/api/status` yanıtına, ham provider hatası sunucu loguna girebilir. [Bulgu defterindeki](../security/findings.md) canary testiyle mainnet öncesi kapatılacak.
- [x] **I16 ağ ayrımı bulgusu:** `bc3fcb8` mainnet komutunu mainnet'e sabitledi; mevcut eksik `.env.mainnet` ile gerçek başlatma, testnet'e dönmeden `SOROBAN_RPC_URL is required on mainnet` hatasında durdu. [Bulgu](../security/findings.md) kapandı.
- [ ] **Faz 4 Vercel provası:** üç ayrı Vercel projesi, gerçek owner passkey origin'i, Supabase collector/status/export ve ilk teknik değerlendirme.
- [ ] **Kapı 3 ve D2:** tarihli mainnet kararı, üretim kimlikleri, trustline, kontrollü deploy/fonlama, hosted settlement/PoI, owner kontrolleri ve recovery.
- [ ] **D3 ve final:** iki anonim değerlendirme, rızalı video, H1–H5 kararı, uygulanan değişiklik, canlı landing/status, trafik ve event export, pilot raporu, Drive arşivi ve `v0.2.0`.

### Claude–Codex iş bölümü — 2 Ekim'den sonrası

Bu bölüm aynı dosyada eşzamanlı düzenlemeyi ve çift zincir işlemini önlemek için uygulanır. Claude `895db7b` ile Kapı 1'i geçti, ardından `0a19872` ile üç Vercel projesini dağıttı ve `bc3fcb8` ile gizlilik/ağ düzeltmelerini yaptı. Bundan sonraki her işte önce son commit ve `git status` kontrol edilir; bir tarafın kaydedilmemiş değişikliği diğer tarafça değiştirilmez. Claude bu paylaşımı kendi oturumunda gördüğünde işin kapsamını teyit ederek sürdürür; iki terminal arasında otomatik konuşma yoktur.

| Alan | Claude'un sorumluluğu | Codex'in sorumluluğu | Emir / dış taraf |
|---|---|---|---|
| **Kapı 2, D1 release** | `contracts/`, `backend/`, `frontend/`, `.github/`, deploy scripti ve testlerde gereken düzeltmeler; artifact üretimi, CI ve release adayının hazırlanması. | Kaynak diff'i, güvenlik değişmezlerini, test/CI/audit sonuçlarını ve artifact hash eşleşmesini bağımsız kontrol etmek; [plan](month-2-execution-plan.md), [hazırlık listesi](readiness-checklist.md), [bulgu defteri](../security/findings.md) durumunu kanıtla güncellemek. | Emir kodu yazmamış Rust/Stellar inceleyiciyi sağlar. Dış peer review'u Codex incelemesi karşılamaz. |
| **Supabase ve barındırma** | Vercel'de üç rolü, origin/redirect'i, gerçek passkey akışını, collector/status/export'u çalışır hale getirmek; uygulama veya SQL düzeltmesi gerekiyorsa kodunu yapmak. | Mainnet/testnet şemasını **salt okunur** doğrulamak, migration yollarını uzlaştırmak, RLS/anon izinleri ile servis rolü ayrımını raporlamak; Vercel uçtan uca sonuçlarını kanıt açısından kontrol etmek. | Emir proje erişimi, kalıcı alan adı ve gerekli secret'ları yalnız servis ayarlarında sağlar. |
| **Kapı 3 ve D2 mainnet** | Onaydan sonra tek operatör olarak preflight, deploy, fonlama/ödeme scriptleri ve owner işlem akışını yürütmek; [deploy kaydını](deployment-record.md) doldurmak. | Karar öncesi kontrol listesi ve riskleri denetlemek; işlem sonrası public RPC/explorer, limitler, settlement/PoI ve kayıtları ikinci göz olarak doğrulamak; [kanıt dizinini](../evidence.md) güncellemek. **Codex aynı işlemleri yeniden göndermez.** | Emir tarihli go/no-go kararını verir, production passkey ile owner işlemlerini onaylar ve yalnız kendi pilot fonunu sağlar. |
| **D3 ve son teslim** | Landing/status ve collector'daki kusurları düzeltmek, production deploy ve teknik demo akışını hazırlamak; scriptli olay/göç kayıtlarını üretmek. | Landing gizlilik/bağlantı/ekran boyutu QA'sı; iki oturumun anonim özetleri ve H1–H5 analizi; trafik/olay/limit raporu, final pilot raporu, teslim matrisi ve Drive kanıt indeksini hazırlamak. | Emir iki katılımcıyla oturumları, açık kayıt rızasını, özel video/Drive erişimini ve dışa paylaşım kararını yönetir. |

**Dosya sınırı:** Claude uygulama kodu ve testleri, `.github/`, `scripts/deploy.sh`, `docs/mainnet/x402-compat.md`, `docs/mainnet/release.md`, `docs/mainnet/deployment-record.md` ve `docs/operations/rehearsals/` üzerinde çalışır. Codex bu plan, `docs/mainnet/readiness-checklist.md`, `docs/security/findings.md`, `docs/evidence.md` ve yeni doğrulama/teslim raporları üzerinde çalışır. Ortak bir dosya gerekli olursa önce mevcut diff incelenir ve yalnız tek taraf o dosyayı düzenler. Supabase'in mevcut untracked migration dosyaları ve `docs/mainnet/supabase.md` doğrulama tamamlanana kadar değiştirilmez.

## 2. Faz 0 — Kapsam ve ortam doğrulaması

**Girdi:** Doldurulmuş SOW, Customer Development Plan, mevcut repo, Supabase projeleri. **Sorumlu:** uygulayıcı; proje ve harici hesap doğrulaması Emir.

| ID | Yapılacak iş | Kabul ve kaydedilecek kanıt |
|---|---|---|
| 0.1 | D1, D2, D3 ve müşteri planındaki her sözü aşağıdaki eşleme tablosuna bağla; kapsam değişikliklerini bölüm lideriyle yazılı kaydet. | Bu belgedeki eşleme ve teslim indeksi kaynak PDF ile satır satır uyumlu. |
| 0.2 | Repo dalını, kaydedilmemiş işleri, son CI sonucunu, mevcut test sayılarını, açık bulguları ve release artifact'ını yeniden ölç. | Tarihli baseline; komut, commit ve CI URL'si; başkasının devam eden işi yanlışlıkla tamamlandı sayılmaz. |
| 0.3 | Mainnet ve testnet Supabase projelerini ayır; uygulanan migration'ları salt okunur sorguyla doğrula; RLS, service-role ve anon izinlerini denetle. | Şema envanteri: tablo/fonksiyon adı, uygulanan kaynak SQL, tarih, proje takma adı, RLS sonucu; gizli anahtar yok. İki migration yolunun uyuşmazlığı kapatıldı. |
| 0.4 | Üretim alan adını ve `RP_ID`/`ORIGIN` eşleşmesini kesinleştir; üç Vercel proje adını, anahtar rol dağılımını ve veri akışını kaydet. | Alan adı boşta ve deploy edilebilir; frontend `/api/*` yönlendirmesi aynı origin'i koruyor; rollerin env listesi var. |
| 0.5 | Dış inceleyiciye inceleme paketini gönderme takvimini; en az iki hedef teknik katılımcının rollerini ve iki oturum tarihini kesinleştir. | [Değerlendirme takvimi](../customer/schedule.md) ad içermez, tarih/kurum tipi/oturum türü doludur; peer reviewer daveti özel kanalda saklanır. |
| 0.6 | Testnet/mainnet RPC ve facilitator uçlarını, USDC issuer/SAC eşleşmesini, ağ geçişini ve ücret limitini canlı uçlardan tekrar doğrula. | Tarihli RPC `getVersionInfo` + `getNetwork`, asset türetimi, facilitator `/supported` çıktısının hassas veri içermeyen özeti. |

**Çıkış:** Belirsizlikler `bekliyor` olarak görünür. Migration veya protokol durumunu yalnızca önceki PDF'nin iddiasına dayanarak kapatma.

## 3. Faz 1 — D1 kontrat, istemci ve güvenlik değişmezleri

**Girdi:** Faz 0 baseline. **Çıkış:** incelenebilir kaynak, adversarial testler ve ağdan bağımsız yapılandırma. Mevcut kodun varlığı bu kabul koşullarını düşürmez.

| ID | İş | Kabul / asgari test |
|---|---|---|
| 1.1 | SDK/CLI, JS SDK ve x402 sürümlerini seçilen ağ protokolüyle eşleştir; lockfile ve toolchain'i sabitle. | Rust/TS derleme; seçilen sürümler ve canlı protokol kayıtlı; yeni protokole karşı testnet simülasyonu yapılmış. |
| 1.2 | Testnet/mainnet passphrase, CAIP-2, RPC, USDC SAC, facilitator ve explorer yapılandırmasını tek doğrulama yolundan geçir. | Yanlış RPC passphrase, asset, CAIP-2 veya contract ID başlangıçta reddedilir; yanlış ağ için imza üretilmez. |
| 1.3 | Kontratın immutable ve tek varlık/tek merchant kuralını, owner/agent ayrımını, passkey RP/UV kontrollerini doğrula. | Yetkisiz owner işlemi, yanlış RP/type/UV, onaysız merchant, yanlış asset ve upgrade yolu reddedilir; yetki ağacı test edilir. |
| 1.4 | Tekil/24 saatlik adet/24 saatlik toplam limitleri ve replay penceresini doğrula. | 1 USDC üstü; 5'inci ödeme toplamı aşması; kayan pencere sınırı; freeze/restore sonrası sayaç; sona ermiş ve tekrar nonce senaryoları geçer. Limit artırma hiçbir owner yolu ile kabul edilmez. |
| 1.5 | Acil fon kurtarmayı sabit recovery adresine ve `frozen` durumuna bağla; kalan bakiyeyi kontrol et. | Agent kurtaramaz; owner başka alıcı seçemez; donmamış hesap reddedilir; işlem ve event şeması test edilir. |
| 1.6 | Kalıcı state/kod TTL'sini işletim çağrılarında uzat; ödeme yolu referans facilitator ücret tavanı altında kalsın. | Ledger ilerletilen TTL testleri, arşiv eşiği denemesi ve taze testnet ücreti; ödeme simülasyonunda gereksiz storage/event yok. |
| 1.7 | `publish_proof` tek seferlik, yalnızca kaydedilmiş ödeme verisinden event yayımlar; tüm owner eylemlerinin privacy koruyan event şeması vardır. | Aynı nonce ikinci kez ret; uydurma proof ret; transfer ve proof işlemleri hash/nonce ile eşleşir; event'ler özel istek verisi taşımaz. |
| 1.8 | Agent bearer token ve merchant allowlist; merchant kesinleşmiş zincir settlement'ını ağ, asset, gönderen, alıcı, tutar ve tek kullanım açısından tekrar doğrular. | Eksik token/izin dışı host/yanlış veya sahte `PAYMENT-RESPONSE`/tekrar ödeme içerik açmaz. Başarılı ödeme açar. |
| 1.9 | Supabase passkey challenge ve rate limit akışını stateless backend ile doğrula; owner ve merchant rollerini ayrı process/proje içinde çalıştır. | İki ayrı istekte kayıt/giriş tamamlanır; iki ayrı instance aynı rate limit'i görür; prod env'de varsayılan `RP_ID`, `ORIGIN` veya testnet sabiti yok. |
| 1.10 | Rust–TypeScript canonical encoding ve hata eşlemesini kilitle. | Ortak vektörler; query/path case değişimi, body/method/endpoint mutasyonu ve policy hata adları iki dilde aynı sonuca gider. |

**Doğrulama:** `cargo test`, katı `cargo clippy`, `stellar contract build`, backend test/TS derleme, frontend derleme, üretim bağımlılık denetimleri, event ve konfigürasyon testleri. Test raporu, çalıştırıldığı commit ile kaydedilir. Güvenlik için yalnızca `mock_all_auths` kullanan testler yeterli değildir; owner ve agent için gerçek beklenen auth ağacı veya spesifik mock doğrulanır.

## 4. Faz 2 — D1 x402 v2 ve Kapı 1

**Girdi:** Faz 1 ödeme kodu ve testnet pilot hesapları. **Harici ihtiyaç:** OZ hosted testnet API anahtarı, testnet owner passkey etkileşimi ve testnet USDC.

1. Merchant `PAYMENT-REQUIRED` içinde v2 `exact`, `stellar:testnet`, resmi testnet asset, alıcı, tutar, zaman aşımı ve `extensions.beaver402` challenge üretir. Alıcı bu alanları merchant imzası ve bağımsız intent ile bire bir bağlar; yetki XDR'si yalnızca gerekli token transferini kapsar.
2. Önce sahte/yanlış alan senaryoları referans `@x402/stellar` doğrulayıcısında test edilir; bu sonuç **Kapı 1 yerine geçmez**. Gerçek MCP aracı ödeme başlatır; barındırılan facilitator `/verify` ve `/settle` sonucuyla ücreti sponsorlayıp testnet'e gönderir.
3. Merchant RPC'den kesinleşmeyi tekrar doğrular, korumalı yanıtı döndürür ve proof'u ayrı işlemle yayımlar. İki işlem aynı nonce/challenge hash'e bağlanır. Tekrar kullanım, yanlış tutar/alıcı, sahte header ve request mutation retleri belgelenir.
4. [Uyumluluk kaydına](x402-compat.md) facilitator kimliği/sürümü, `/supported` özeti, ağ, ödeme işlem hash'i, proof işlem hash'i, ücret ve MCP izinin hassas veri içermeyen özeti yazılır.

**Kapı 1 kabulü:** Barındırılan facilitator ile MCP'den başlatılan **gerçek testnet USDC** ödemesi başarılı; facilitator ücret sponsorluğu, merchant zincir doğrulaması, korumalı yanıt ve PoI event'i doğrulanmış; aynı kaynaktan tekrarlanabilir kayıt var. Barındırılan servis custom account veya imzayı reddederse bulgu kaydedilir, entegrasyon düzeltilir; mainnet yolu kapalı kalır.

## 5. Faz 3 — D1 release candidate, dış inceleme ve Kapı 2

**Girdi:** Kapı 1; açık kod ve test kapsamı. **Sorumlu:** uygulayıcı ve kodu yazmamış dış Rust/Stellar inceleyici.

| ID | İş | Kabul / kanıt |
|---|---|---|
| 3.1 | CI'ı tek release commit'inde çalıştır: kontrat/backend/frontend test, çapraz dil vektörleri, build, katı Clippy, Rust/Node prod audit, immutable kontrolü. | Tüm job'lar yeşil; CI run linki ve kullanılan commit aynı. Uyarı istisnaları gerekçeli ve inceleyiciye açık. |
| 3.2 | Sabit toolchain ile optimize WASM derle; SHA-256, byte boyutu ve source commit'i kaydet; CI artifact'ı ile yerel build'i karşılaştır. | İki hash aynı; [release kaydı](release.md) güncel; deploy script `EXPECTED_WASM_HASH` uyuşmazlığını reddediyor. |
| 3.3 | Dış inceleyiciye `__check_auth`, limitler, nonce/proof, passkey, recovery, x402 merchant doğrulaması, RLS, rol ayrımı, migration ve operasyon akışını ver. | İnceleme kapsamı ve reviewer bağımsızlığı [inceleme paketinde](../security/review-brief.md); görüşler tarihli [bulgu defterine](../security/findings.md) yazılır. |
| 3.4 | Her kritik/yüksek bulguyu düzelt ve yeniden test et; diğer bulguların kabul/erteleme gerekçesini yaz. | Açık kritik/yüksek yok; reviewer yeniden kontrol etti; kod commit'i bulguya bağlandı. |
| 3.5 | `v0.2.0-rc.N` release ve hash'li artifact yayımla; [hazırlık listesini](readiness-checklist.md) kanıtla doldur. | Etiket, source commit, CI run, artifact, review ve risk kaydı birbiriyle eşleşiyor. |

**Kapı 2 kabulü:** D1'in tüm statik ve dinamik doğrulamaları yeşil, dış peer review kayıtlı, kritik/yüksek bulgu yok, deploy edilecek artifact'ın hash'i incelenen hash. İnceleme sonrası kaynak değişirse etkilenen testler ve inceleme tekrar yapılır; hash değişirse yeni release candidate hazırlanır.

## 6. Faz 4 — D3 barındırma, operasyon ve tam testnet prova

**Girdi:** D1 release candidate. **Çıkış:** mainnet topolojisinin testnet eşdeğeriyle sınanmış operasyon paketi.

| ID | İş | Kabul / kanıt |
|---|---|---|
| 4.1 | Frontend, agent, merchant için üç ayrı Vercel projesi kur; tek public panel origin'i ve `/api/*` yönlendirmesini tamamla. | Production preview'da passkey kayıt/giriş ve protected request uçtan uca; agent/merchant env anahtarları birbirine görünmez. |
| 4.2 | Supabase testnet şemasını doğrula; collector, status ve sayfa metriğini gerçek testnet olaylarıyla çalıştır. | `chain_events` ve cursor kesintiden sonra devam eder; açık event export'u; `/status` son toplama ve hatayı gösterir; özel veri sızmaz. |
| 4.3 | Testnet'te aynı release artifact'ıyla deploy → owner merchant onayı → fonlama → hosted facilitator ödemesi → proof → saldırı senaryoları → freeze/restore/revoke/remove/limit/recovery → yeni kontrata göç prova et. | [Scriptli hosted prova](../operations/rehearsals/2026-10-02-testnet-hosted.md) tamam. Aynı akışın Vercel ve gerçek cihaz passkey'iyle uçtan uca provası yeni tarihli kayda yazılır; [yerel referans provası](../operations/rehearsals/2026-10-02-testnet-reference.md) ayrı tutulur. |
| 4.4 | Landing page'i 390 px ve 1440 px'de kontrol et; risk, PoI, Stellar/x402, pilot sınırı, passkey kontrolleri, kısıtlar, repo, demo, docs ve `/panel` bağlantıları doğrula. | Önizleme URL'si, mobil/masaüstü ekran görüntüsü, klavye ile gezinme ve gizlilik inceleme kaydı. Mainnet linkleri henüz yayınlanmaz. |
| 4.5 | Olay, göç, deploy ve günlük işletim rehberlerini gerçek prova adımlarıyla hizala. | [Olay prosedürü](../operations/incident-response.md), [göç prosedürü](../operations/migration.md), [işletim rehberi](../operations/operating-guide.md) ve [bilinen kısıtlar](../known-limitations.md) prova sonucu ile tutarlı. |
| 4.6 | İlk yapılandırılmış teknik değerlendirmeyi testnet kanıtı ve landing önizlemesiyle yap. | Katılımcı rolü/kurum tipi, tarih, gözlem ve anonim özet; kayıt için önceden rıza alınmadıysa kayıt yapılmaz. |

**Faz 4 çıkış kontrolü:** Vercel route ve origin sabit, testnet ortamında operasyon yolu gerçekten çalışmış, collector boşlukları görülebilir, kullanıcı oturumu 1 belgelenmiş. Barındırma ve migration farklıysa Kapı 3 açılmaz.

## 7. Faz 5 — D2 mainnet kararı ve kontrollü deploy

**Kapı 3, deploy öncesi:** Kapı 1 + Kapı 2 kayıtları, Faz 4 hosted prova, [hazırlık listesinin](readiness-checklist.md) tüm satırları ve açık risklerin sahibi/azaltması kontrol edilir. Emir `go` veya `no-go` kararını tarih, source commit, artifact hash, hedef ağ ve finansal sınırlarla imzalar. `No-go` durumunda zincir işlemi yapılmaz.

**Üretim kurulum sırası:**

1. Sabit production origin'de **yeni** owner passkey kaydet. Ayrı agent signer, merchant signer ve operasyonel fee hesabı yarat; recovery adresi Emir'in USDC alabilen cüzdanı olsun. Her gizli anahtar yalnızca ilgili servisin secret store'unda. Testnet anahtarları, passkey kayıtları ve verileri taşınmaz.
2. Salt okunur preflight: mainnet RPC ağ kimliği/protokolü; resmi Circle USDC issuer'dan türetilen SAC ve [Stellar x402 varlık tablosu](https://developers.stellar.org/docs/build/agentic-payments/x402) ile eşleşme; merchant ve recovery trustline; OZ `/supported`; contract ve artifact hash; fee/TTL simülasyonu; Supabase RLS; Vercel origin/env. Çıktı gizli değer taşımaz.
3. İncelenmiş WASM'ı yükle ve immutable account'ı sınırlı constructor argümanlarıyla deploy et. Read metotları, owner/signer/merchant/recovery açık kimlikleri, asset, limit, frozen durumu ve TTL'i iki bağımsız okumayla doğrula.
4. Owner passkey ile yalnızca referans merchant'ı onayla. Bakiye sıfırdan doğrulandıktan sonra builder'ın kendi fonundan **5 USDC** aktar. Önce ve sonra toplam bakiyenin **10 USDC'yi aşmadığını** kaydet. Operasyonel fee hesabını yalnız deploy/owner işlemleri için kullan.
5. Agent, merchant ve frontend üretim deploy'larını doğrula; event collector'ı ilk kez elle çalıştır; `/status` ile event cursor ve kontrat durumunu karşılaştır. Korumalı endpoint'in ödemesiz 402 döndürdüğünü doğrula.
6. [Deploy kaydını](deployment-record.md) oluştur: tarih, network/passphrase doğrulaması, source commit, CI/review/release linkleri, WASM hash, contract ID, code hash, constructor limitleri, public rol kimlikleri, facilitator, fonlama ve owner işlem hash'leri; gizli değer yok.

**Faz 5 çıkış:** Mainnet kontratı ve fonlama explorer'da doğrulanabilir; varsayılan testnet değerleri yok; collector hazır. Bu adımlar gerçek değer taşıdığı için yalnız tarihli Kapı 3 kararıyla yapılır.

## 8. Faz 6 — D2 canlı ödeme ve güvenlik kontrol sırası

**Girdi:** Faz 5 çıkış ve 24 saatlik limitte yeterli kapasite. Her başarılı ödeme öncesi kalan 24 saat kapasitesi ve bakiye kontrol edilir. İstem dışı tekrar ödeme yapılmaz. Ret testlerinde zincir settlement'ı bulunmadığı kanıtlanır; mümkünse aynı test verisi tekrar kullanılabilir biçimde saklanır.

| Sıra | İşlem | Beklenen kanıt |
|---|---|---|
| 6.1 | MCP aracından ≤1 USDC protected request. | Merchant challenge, buyer intent ve yetki hash'leri; hosted facilitator `verify/settle` özeti; USDC settlement tx; korumalı yanıt; bağlı PoI tx/event. |
| 6.2 | İmzalanan endpoint/query/body/method'dan birini değiştir. | İsimli ret, içerik yok, settlement yok; özel gövde yayımlanmaz. |
| 6.3 | Owner passkey ile freeze; donukken aynı ödeme denemesi. | Freeze tx/event; `AccountFrozen`, settlement yok. |
| 6.4 | Owner passkey ile restore, sonra bir düşük tutarlı ödeme. | Restore tx/event, yeni settlement+proof; kayan limitler sıfırlanmamış. |
| 6.5 | Agent signer'ı revoke et; ödeme dene; sonra owner ile signer'ı yeniden ayarla. | İki owner tx/event; `SignerRevoked`, settlement yok; yeni signer yalnız owner yetkisiyle. |
| 6.6 | Tüm başarılı ödemelerin merchant hesabına geçtiğini; proof eşleşmesini ve kullanılan kapasiteyi kontrol et. | Tek ödeme izi tablosu; ledger, facilitator, merchant kaydı ve collector tutarlı. |

**D2 kabulü:** En az bir **MCP başlatılmış, hosted x402 v2 facilitator ile settle edilmiş mainnet USDC** ödemesi ve PoI; geçerli/ret/owner kontrol işlemleri; açık deploy kaydı, limit ve gizlilik kanıtı. Acil fon kurtarma kayıtlı canlı ürün oturumundan sonra Faz 7'de yapılır; işlem öncesi owner risk kontrolü ve kalan bakiye tekrar okunur.

## 9. Faz 7 — D3 kullanıcı, operasyon ve pilot kapanışı

| ID | İş | Kabul / kanıt |
|---|---|---|
| 7.1 | İkinci hedef teknik katılımcıyla açık rızalı, kayıtlı ürün değerlendirmesi yap: landing'i bulma, 402 isteğini okuma, PoI/settlement inceleme, passkey freeze/revoke/recovery akışını yorumlama. | Önceden saklanan rıza, zaman damgalı video, anonim oturum özeti; katılımcı kimliği yalnız özel Drive klasöründe. Kayıt hem demo hem görev/UX bölümünü içerir. |
| 7.2 | İki oturumun bulgularını H1–H5'e karşı değerlendir: desteklendi / desteklenmedi / belirsiz. | [Hipotez tablosu](../customer/hypothesis-results.md) her karar için gözlem atfı ve sınırlama içerir; ödeme isteği, merchant imzası, owner kontrolleri, mainnet güveni, entegrasyon anlaşılabilirliği kapsanır. |
| 7.3 | Bulgulardan en az bir ürün/landing/doküman değişikliği seç, uygula ve katılımcı gözlemine bağla. | Karar gerekçesi, önce/sonra örneği, commit ve gerekiyorsa kısa doğrulama. |
| 7.4 | Owner ile canlı incident tatbikatı: freeze → signer revoke → merchant remove → limit azaltma → sabit recovery adresine kalan fonu kurtarma. | Her başarılı owner tx/event'i ve son bakiye; yanlış adrese kurtarma/limit artırma başarısız; işlem sırası [olay prosedürüne](../operations/incident-response.md) bağlı. |
| 7.5 | İmmutable göç prosedürünü aynı release veya yeni incelenmiş artifact ile **testnet** üzerinde yeniden prova et. | Eski hesap dondurulmuş ve delili korunmuş; yeni hesap deploy/merchant onayı/ilk ödeme/proof; iki contract ID ve işlem dizini. |
| 7.6 | Mainnet'in tüm pilot dönemini denetle: her kayan 24 saatte ödeme adedi/toplamı, tekil tutarlar, her fonlama/bakiye, merchant/alıcı, retler ve owner işlemleri. | 1/5/5/10 sınırları aşılmamış; ledger ile collector/export sayıları uzlaşıyor; eksik event varsa açıkça işaretli. |
| 7.7 | Çerezsiz trafik ve kullanım özetini çıkar. | Günlük ziyaret ve doküman/repo tıklamaları; korumalı istek, başarılı settlement, ret ve owner işlemlerinin yalnız toplu sayıları; kişisel tanımlayıcı yok. |
| 7.8 | Final landing'i doğrulanmış mainnet bağlantıları ve pilot limitleriyle yayımla; mobil/masaüstü ekran görüntüsü ve demo çek. | Public URL; linklerin her biri açılıyor; demo gerçek hosted akışını ve güvenlik kontrollerini doğru anlatıyor; özel veri yok. |
| 7.9 | Pilot raporu, operasyon export'u, tehdit modeli, bilinen kısıtlar ve 3. ay önerisini güncelle. | Başarılar, retler, olaylar, açık riskler, müşteri bulguları ve bir sonraki ayın gerekçesi kaynak kanıtına bağlı. |

Kayıt için rıza verilmezse oturum kaydedilmez; rıza veren başka hedef katılımcıyla oturum planlanır. Değerlendirme ve demo tamamlanmadan fonlar kurtarılarak canlı akış kapatılmaz.

## 10. Faz 8 — Teslim paketi ve son kontrol

1. Her kanıt için tek indeks oluştur: kısa iddia, ağ, tarih, kaynak commit, public URL/tx, özel Drive dosyası varsa yalnız erişim yolu, doğrulama adımı. İlk ay [kanıt dizinindeki](../evidence.md) testnet kanıtları ikinci ay mainnet kanıtlarından açıkça ayrılır.
2. D1: public release ve CI raporu; hosted facilitator **testnet** ödemesi; x402 raporu; optimize WASM/hash; readiness kararı; peer review ve bulgular. D2: mainnet kontrat/deploy, USDC settlement/PoI, owner işlemleri/recovery, limit denetimi, ekranlar ve demo. D3: canlı landing, responsive ekranlar, iki anonim özet, rızalı kayıt, hipotezler, seçilen değişiklik, event export, olay/göç provası, işletim belgeleri ve final rapor.
3. Drive arşivini ilk aydaki dizin yapısında güncelle; private kayıt ile public kanıtı ayır. Bölüm lideri için yalnız ana indeksten tüm D1–D3 kanıtlarına en fazla iki tıklamayla erişilebildiğini farklı tarayıcı oturumunda kontrol et. Erişimi olmayan kanıt `teslim` sayılmaz.
4. Son kod/deploy source commit'i, artifact hash'i, CI run ve mainnet code hash'i birbirine bağla; `v0.2.0` etiketini aynı source commit'e koy. README ve landing'in sürüm/deploy linkleri tutarlı olsun.
5. Son teslim kontrolünde her SOW ve Customer Development Plan satırını `kanıtlandı / eksik` olarak imzala. Eksik satır varsa ikinci ay tamamlandı denmez.

### Kaynak taahhüt → teslim kanıtı

| Taahhüt | Zorunlu çıktı / doğrulama |
|---|---|
| **D1:** mainnet uyumlu, güvenliği sertleştirilmiş, x402 v2 release candidate | Faz 1 testleri, Kapı 1 hosted testnet ödeme, Kapı 2 review+artifact+CI; network, limit, WebAuthn, TTL, recovery ve merchant doğrulaması kanıtları |
| **D2:** finansal olarak sınırlı Stellar mainnet pilotu | Kapı 3 kararı, ayrı üretim kimlikleri, USDC SAC/trustline, deploy+fonlama, Faz 6 hosted settlement/PoI ve ret/owner işlemleri, Faz 7 recovery ve limit denetimi |
| **D3:** landing, operasyon, teknik kullanıcı değerlendirmesi | Faz 4/7/8: canlı sayfa, `/status`, collector/export, olay ve göç prova, iki özet, rızalı video, H1–H5, kanıta bağlı değişiklik, trafik, rapor, demo |
| **Müşteri planı:** hedef segment ve öğrenme | En az iki hedef katılımcı; ilk testnet, ikinci mainnet değerlendirmesi; rol/kurum tipi/rıza; beş hipotez; 3. ay için katılımcı bulgularına dayalı öneri |
| **SOW hafta 1–4 çıktıları** | Hafta 1 = Faz 0–2; hafta 2 = Faz 3–4; hafta 3 = Faz 5–6 ve kayıtlı oturum; hafta 4 = Faz 7–8. Gerçek tarihler gecikirse faz sırası/kapılar korunur ve takvim sapması kaydedilir. |

### Kullanıcıdan / harici taraflardan gerekenler

| Girdi | En geç | Bugünkü kayıt |
|---|---|---|
| Mainnet Supabase proje ve SQL migration kanıtı | Faz 0 | proje ve migration kullanıcı tarafından bildirildi; şema/003 doğrulaması açık |
| OZ hosted **testnet** API erişimi ve testnet fonu | Kapı 1 | [hosted testnet MCP ödeme ve PoI](../operations/rehearsals/2026-10-02-testnet-hosted.md) tamam; gerçek cihaz passkey'iyle Vercel provası Faz 4'te açık |
| Üretim Vercel hesabı, kalıcı origin ve üç proje | Faz 4 | doğrulanacak |
| İki katılımcı, oturum takvimi, biri için açık kayıt rızası | Faz 4 / Faz 7 | takvim dosyasında tarih boş |
| Koddan bağımsız Rust/Stellar peer reviewer | Kapı 2 | inceleme kaydı henüz yok |
| Mainnet RPC ve OZ hosted mainnet API erişimi | Kapı 3 | canlı preflight gerekli |
| Recovery cüzdanı + USDC trustline; 5 USDC ve gerekli XLM | Faz 5 | zincirde doğrulanacak |
| Mainnet `go/no-go`, owner passkey imzaları ve canlı oturum | Faz 5–7 | yalnız gerçek işlem anında |

## 11. İkinci ayın “bitti” tanımı

- [ ] Kapı 1, Kapı 2 ve Kapı 3 tarihli, kaynak commit ve kanıt bağlantılı.
- [ ] D1 release artifact'ı incelenen/deploy edilen hash ile aynı; CI ve dış review temiz.
- [ ] Hosted facilitator ile MCP testnet ödemesi **ve** hosted facilitator ile MCP mainnet ödemesi ayrı ayrı doğrulanmış.
- [ ] Mainnet USDC settlement, protected response ve bağlı PoI event'i public işlem referanslarıyla görülebiliyor.
- [ ] D2 ret, freeze, restore, signer revoke ve recovery adımları; 1/5/5/10 limit denetimi kanıtlı.
- [ ] Landing, `/status`, collector ve event export çalışıyor; sayfa mobil/masaüstü kanıtlı.
- [ ] İki anonim değerlendirme özeti, bir açık rızalı video, H1–H5 tablosu ve uygulanmış değişiklik var.
- [ ] Incident ve migration provaları, trafik raporu, pilot raporu, tehdit modeli, bilinen kısıtlar ve 3. ay önerisi var.
- [ ] Public kanıt dizini ve private Drive arşivi bölüm lideri açısından erişilebilir; `v0.2.0` etiketi doğru commit'te.
- [ ] SOW ve müşteri planında eksik taahhüt yok; kapsam dışı iş yapılmamış.
