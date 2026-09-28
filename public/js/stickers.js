// Cute Sticker Collections: Tê Giác (Rhino 🦏) & Mèo Con (Cat 🐱) & Tình Yêu (Love 💖)

const STICKER_COLLECTIONS = {
  cats: {
    id: "cats",
    name: "Mèo Con",
    icon: "🐱",
    stickers: [
      {
        id: "cat_heart",
        emoji: "🐱💖",
        name: "Mèo ôm tim",
        text: "Yêu người iu nhìu lắm á! 💖",
        bg: "linear-gradient(135deg, #ffccd5, #ffb3c6)",
        anim: "bounce"
      },
      {
        id: "cat_kiss",
        emoji: "😽💋",
        name: "Mèo hôn gió",
        text: "Chụt chụt moah moah nè! 💋",
        bg: "linear-gradient(135deg, #ffe5ec, #ffc2d1)",
        anim: "pulse"
      },
      {
        id: "cat_chill",
        emoji: "🎧🐱",
        name: "Mèo nghe nhạc",
        text: "Giai điệu này phiêu quá nha ~ 🎶",
        bg: "linear-gradient(135deg, #e8dff5, #fce1e4)",
        anim: "shake"
      },
      {
        id: "cat_flower",
        emoji: "🌹🐱",
        name: "Mèo tặng hoa",
        text: "Tặng bông hồng cho bé nè 🌹",
        bg: "linear-gradient(135deg, #ffccd5, #fff0f3)",
        anim: "bounce"
      },
      {
        id: "cat_plead",
        emoji: "🥺🐾",
        name: "Mèo năn nỉ",
        text: "Thương tui một chút đi mừ 🥺",
        bg: "linear-gradient(135deg, #ddbdfc, #fcd5ce)",
        anim: "pulse"
      },
      {
        id: "cat_pout",
        emoji: "😾💢",
        name: "Mèo dỗi hờn",
        text: "Dỗi rồi! Phải dỗ mới hết nha 😾",
        bg: "linear-gradient(135deg, #fed9b7, #f07167)",
        anim: "shake"
      },
      {
        id: "cat_sleep",
        emoji: "💤🐱",
        name: "Mèo ngủ khò",
        text: "Buồn ngủ rồi, chúc ngủ ngon 🌙",
        bg: "linear-gradient(135deg, #d8e2dc, #ffe5d9)",
        anim: "pulse"
      },
      {
        id: "cat_dance",
        emoji: "💃🐱",
        name: "Mèo nhảy múa",
        text: "Vui vẻ quẩy nhạc cùng nhau! ✨",
        bg: "linear-gradient(135deg, #fde2e4, #fad2e1)",
        anim: "bounce"
      }
    ]
  },
  rhinos: {
    id: "rhinos",
    name: "Tê Giác",
    icon: "🦏",
    stickers: [
      {
        id: "rhino_love",
        emoji: "🦏💕",
        name: "Tê giác bắn tim",
        text: "Tê giác phóng tim bùm chíu! 💕",
        bg: "linear-gradient(135deg, #e2eafc, #cddafd)",
        anim: "bounce"
      },
      {
        id: "rhino_flower",
        emoji: "🦏💐",
        name: "Tê giác tặng hoa",
        text: "Bó hoa siêu bự tặng bạn gái 💐",
        bg: "linear-gradient(135deg, #d7e3fc, #ccdbfd)",
        anim: "pulse"
      },
      {
        id: "rhino_chill",
        emoji: "🎧🦏",
        name: "Tê giác đeo tai nghe",
        text: "Tê giác phiêu theo điệu nhạc 🎧",
        bg: "linear-gradient(135deg, #b9fbc0, #98f5e1)",
        anim: "shake"
      },
      {
        id: "rhino_blush",
        emoji: "😳🦏",
        name: "Tê giác đỏ mặt",
        text: "Người ta ngại ngùng má đỏ ó 😳",
        bg: "linear-gradient(135deg, #ffcbf2, #f3c4fb)",
        anim: "pulse"
      },
      {
        id: "rhino_puff",
        emoji: "😤🦏",
        name: "Tê giác phì mũi",
        text: "Hứ, hờn dỗi nhẹ một xíu 😤",
        bg: "linear-gradient(135deg, #e0aaff, #c77dff)",
        anim: "shake"
      },
      {
        id: "rhino_shield",
        emoji: "🛡️🦏",
        name: "Tê giác bảo vệ",
        text: "Luôn bảo vệ và che chở cho em 🛡️",
        bg: "linear-gradient(135deg, #a0c4ff, #bdb2ff)",
        anim: "bounce"
      },
      {
        id: "rhino_icecream",
        emoji: "🍦🦏",
        name: "Tê giác ăn kem",
        text: "Mời công chúa ăn kem ngọt ngào 🍦",
        bg: "linear-gradient(135deg, #ffcad4, #b5e2fa)",
        anim: "pulse"
      },
      {
        id: "rhino_sleep",
        emoji: "🌙🦏",
        name: "Tê giác ngủ mơ",
        text: "Trong mơ cũng thấy người yêu 🌙",
        bg: "linear-gradient(135deg, #cbf3f0, #2ec4b6)",
        anim: "pulse"
      }
    ]
  },
  love: {
    id: "love",
    name: "Tình Yêu",
    icon: "💖",
    stickers: [
      {
        id: "love_storm",
        emoji: "💖🔥",
        name: "Bão tim",
        text: "Cơn mưa tim gửi đến người yêu! 💖",
        bg: "linear-gradient(135deg, #ff758f, #ff4d6d)",
        anim: "bounce"
      },
      {
        id: "love_letter",
        emoji: "💌✨",
        name: "Thư tình",
        text: "Bức thư gửi trọn nỗi nhớ nhung 💌",
        bg: "linear-gradient(135deg, #ffb3c6, #ff8fa3)",
        anim: "pulse"
      },
      {
        id: "love_berry",
        emoji: "🍓🍰",
        name: "Dâu tây",
        text: "Ngọt ngào như bánh dâu tây 🍓",
        bg: "linear-gradient(135deg, #ffc2d1, #ffe5ec)",
        anim: "bounce"
      },
      {
        id: "love_ring",
        emoji: "💍🌸",
        name: "Chiếc nhẫn",
        text: "Mãi mãi bên nhau trọn đời nhé 💍",
        bg: "linear-gradient(135deg, #fff0f3, #ffccd5)",
        anim: "pulse"
      }
    ]
  }
};

window.STICKER_COLLECTIONS = STICKER_COLLECTIONS;
