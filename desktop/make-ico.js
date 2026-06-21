const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, 'assets', 'icon.png');
const dst = path.join(__dirname, 'assets', 'icon.ico');

(async () => {
    try {
        const mod = await import('png-to-ico');
        const pngToIco = mod.default || mod;
        const buf = await pngToIco(src);
        fs.writeFileSync(dst, buf);
        console.log('Wrote ' + dst + ' (' + buf.length + ' bytes)');
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
})();
