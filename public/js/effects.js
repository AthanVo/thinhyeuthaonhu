// Effects: Floating Hearts & Love Particles System

class HeartCanvasEffects {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');
    this.particles = [];
    this.emojis = ['💖', '💕', '🌸', '✨', '🍓', '🥰', '💌', '🎵', '💐'];
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.animate = this.animate.bind(this);
    requestAnimationFrame(this.animate);

    // Gently spawn occasional ambient background petals
    setInterval(() => {
      if (this.particles.length < 15) {
        this.spawnAmbientPetal();
      }
    }, 1800);
  }

  resize() {
    this.canvas.width = window.innerWidth;
    this.canvas.height = window.innerHeight;
  }

  spawnAmbientPetal() {
    this.particles.push({
      x: Math.random() * this.canvas.width,
      y: this.canvas.height + 20,
      size: Math.random() * 14 + 14,
      emoji: Math.random() > 0.4 ? '🌸' : '✨',
      vx: (Math.random() - 0.5) * 1.2,
      vy: -(Math.random() * 1.5 + 1.0),
      opacity: Math.random() * 0.4 + 0.3,
      rotation: Math.random() * 360,
      vRot: (Math.random() - 0.5) * 2,
      fadeRate: 0.003
    });
  }

  burst(emoji = '💖', count = 15, originX = null, originY = null) {
    const startX = originX !== null ? originX : this.canvas.width / 2;
    const startY = originY !== null ? originY : this.canvas.height * 0.7;

    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const speed = Math.random() * 5 + 3;

      this.particles.push({
        x: startX + (Math.random() - 0.5) * 40,
        y: startY + (Math.random() - 0.5) * 40,
        size: Math.random() * 18 + 18,
        emoji: emoji || this.emojis[Math.floor(Math.random() * this.emojis.length)],
        vx: Math.cos(angle) * speed * 0.8 + (Math.random() - 0.5),
        vy: -Math.abs(Math.sin(angle) * speed) - Math.random() * 3 - 2, // upward burst
        opacity: 1,
        rotation: (Math.random() - 0.5) * 30,
        vRot: (Math.random() - 0.5) * 4,
        fadeRate: 0.012 + Math.random() * 0.008
      });
    }
  }

  animate() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.rotation += p.vRot;
      p.opacity -= p.fadeRate;

      if (p.opacity <= 0 || p.y < -50 || p.x < -50 || p.x > this.canvas.width + 50) {
        this.particles.splice(i, 1);
        continue;
      }

      this.ctx.save();
      this.ctx.globalAlpha = Math.max(0, p.opacity);
      this.ctx.translate(p.x, p.y);
      this.ctx.rotate((p.rotation * Math.PI) / 180);
      this.ctx.font = `${p.size}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
      this.ctx.textAlign = 'center';
      this.ctx.textBaseline = 'middle';
      this.ctx.fillText(p.emoji, 0, 0);
      this.ctx.restore();
    }

    requestAnimationFrame(this.animate);
  }
}

window.HeartEffects = HeartCanvasEffects;
