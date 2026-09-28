# 🌸 LoveTunes - Phòng Nghe Nhạc Đôi Lãng Mạn (Spotify & YouTube)

Ứng dụng web nghe nhạc trực tuyến được thiết kế riêng cho **bạn và người yêu**, với phong cách **trắng hồng pastel lãng mạn**, giao diện máy đĩa than cổ điển (Vinyl Turntable) và tính năng đồng bộ phát nhạc theo thời gian thực (Real-time Room Sync).

---

## ✨ Điểm Nổi Bật & Tính Năng Chính

1. **Phát Nhạc Trực Tuyến Từ YouTube & Spotify**:
   - **Tích hợp YouTube Audio Engine**: Nghe trọn vẹn mọi bài hát, MV, acoustic, lofi với chất lượng âm thanh cao nhất mà không bị gián đoạn.
   - **Hỗ trợ Link Spotify**: Dán bất kỳ link bài hát Spotify nào (`open.spotify.com/track/...`), hệ thống tự động trích xuất thông tin ảnh bìa và đồng bộ nguồn phát tương ứng.
   - **Tìm kiếm thông minh**: Tìm kiếm nhanh mọi ca khúc hoặc nghệ sĩ yêu thích.
   - **Danh sách thịnh hành có sẵn**: Top V-Pop (Vũ, Grey D, Wren Evans, Sơn Tùng, AMEE), US-UK lãng mạn và Lofi Chill thư giãn đêm muộn.

2. **Phòng Nghe Đôi Đồng Bộ Thời Gian Thực (Socket.io)**:
   - **Tạo & Tham gia phòng**: Mỗi phòng có mã riêng (ví dụ: `SWEET-6850`).
   - **1-Click Mời Người Yêu**: Nhấn nút **"Mời người yêu"** để tự động sao chép link phòng gửi qua Messenger, Zalo hoặc Telegram.
   - **Đồng bộ mọi thao tác**:
     - Cùng Play / Pause bài hát đồng thời.
     - Tua thanh tiến trình (Seek) cùng lúc.
     - Tự động chuyển bài khi hết nhạc.
     - Nút **"⚡ Đồng bộ tức thì"** giúp bắt kịp nhịp nếu mạng một bên bị trễ.

3. **Giao Diện Trắng Hồng & Trải Nghiệm Cặp Đôi (UI/UX)**:
   - **Đĩa Than Vinyl Quay Cổ Điển**: Hiệu ứng đĩa than quay mượt mà, kim đĩa than (Tonearm) tự động hạ xuống khi phát nhạc và nhấc lên khi tạm dừng.
   - **Thanh Sóng Âm (Waveform Visualizer)**: Chuyển động nhảy theo điệu nhạc.
   - **Đồng hồ thời gian bên nhau**: Hiển thị chính xác thời gian hai bạn cùng nghe nhạc với nhau (`Cùng nghe: 01:25:40`).
   - **Hiệu Ứng Bão Tim (Floating Hearts Reaction)**: Nhấn nút hoặc các biểu tượng cảm xúc (`💖`, `🌸`, `🥰`, `✨`, `💌`) để bắn những cơn mưa tim bay lơ lửng trên màn hình của cả hai người.
   - **Khung Chat & Lời Yêu Thương**: Trò chuyện trực tiếp cùng các nút tin nhắn nhanh siêu ngọt ngào (*"Tặng em nè ❤️"*, *"Nhớ em quá 💕"*, *"Hát theo anh nhé 🎤"*).

---

## 🚀 Hướng Dẫn Khởi Động & Sử Dụng

### 1. Khởi động ứng dụng
Mở terminal tại thư mục dự án và chạy:
```bash
npm start
```
Ứng dụng sẽ chạy tại địa chỉ: **`http://localhost:3000`**

### 2. Cách mở rộng để nghe cùng người yêu qua Internet:
Nếu bạn và người yêu ở xa (khác mạng WiFi), bạn có thể dùng một trong hai cách hoàn toàn miễn phí:

- **Cách 1 (Khuyên dùng - Cloudflare Tunnel)**:
  ```bash
  npx cloudflared tunnel --url http://localhost:3000
  ```
  Bạn sẽ nhận được một đường link HTTPS công khai an toàn (ví dụ: `https://xyz.trycloudflare.com`) để gửi cho người yêu cùng vào nghe ngay trên điện thoại hoặc máy tính!

- **Cách 2 (Ngrok)**:
  ```bash
  npx ngrok http 3000
  ```

- **Cách 3 (Cùng mạng WiFi ở nhà)**:
  Chỉ cần thay `localhost` bằng địa chỉ IP máy tính của bạn (ví dụ: `http://192.168.1.5:3000`) là bạn gái có thể mở bằng điện thoại để nghe chung.

---

## 📂 Cấu Trúc Dự Án

```
lovetunes/
├── server.js              # Backend Express + Socket.io + Spotify/YouTube Resolver
├── package.json           # Cấu hình dự án & thư viện
├── public/
│   ├── index.html         # Giao diện HTML5 chuẩn SEO & Accessibility
│   ├── css/
│   │   └── style.css      # Toàn bộ thiết kế Tone Trắng Hồng Pastel & Glassmorphism
│   └── js/
│       ├── app.js         # Quản lý sự kiện phòng đôi, chat, profile & tab
│       ├── player.js      # Bộ điều khiển YouTube IFrame API & logic đồng bộ
│       ├── playlists.js   # Danh sách bài hát thịnh hành V-Pop, US-UK & Lofi
│       └── effects.js     # Hiệu ứng Canvas hạt bão tim & hoa anh đào rơi
└── README.md              # Hướng dẫn chi tiết
```
