/* audio-encode's C side (ADR 0351 §4, 0359): whole-clip encode loops for libvorbis (Ogg Vorbis) and libopus (Ogg Opus,
 * RFC 7845: OpusHead with the encoder's look-ahead as pre-skip, the end trimmed by the last page's granule position),
 * writing into a growable buffer that Rust frees with myco_buf_free. From the A0 spike's glue (spikes/audio-encode). */
#include <stdlib.h>
#include <string.h>

#include <ogg/ogg.h>
#include <opus.h>
#include <vorbis/vorbisenc.h>

typedef struct {
  unsigned char *data;
  size_t len, cap;
  int failed; /* set when a realloc failed: the output is incomplete */
} myco_buf;

static void buf_put(myco_buf *b, const unsigned char *p, size_t n) {
  if (b->failed) return;
  if (b->len + n > b->cap) {
    size_t cap = b->cap ? b->cap : 65536;
    while (cap < b->len + n) cap *= 2;
    unsigned char *d = (unsigned char *)realloc(b->data, cap);
    if (!d) {
      b->failed = 1;
      return;
    }
    b->data = d;
    b->cap = cap;
  }
  memcpy(b->data + b->len, p, n);
  b->len += n;
}

void myco_buf_free(myco_buf *b) {
  free(b->data);
  b->data = 0;
  b->len = b->cap = 0;
  b->failed = 0;
}

static void put_page(myco_buf *b, ogg_page *og) {
  buf_put(b, og->header, (size_t)og->header_len);
  buf_put(b, og->body, (size_t)og->body_len);
}

/* The Ogg stream serial both encoders write ("myco"). */
#define MYCO_SERIAL 0x6d79636f

/* q: libvorbis VBR quality, -0.1..1.0 (ADR 0351 §2: quality x 10 is the familiar -q scale).
 * Returns 0, -1 when libvorbis refuses the rate/channels/quality, -3 when out of memory. */
int myco_vorbis_encode(const float *interleaved, int ch, long frames, long rate, float q, const char *vendor,
                       myco_buf *out) {
  vorbis_info vi;
  vorbis_comment vc;
  vorbis_dsp_state vd;
  vorbis_block vb;
  ogg_stream_state os;
  ogg_page og;
  ogg_packet op;
  vorbis_info_init(&vi);
  if (vorbis_encode_init_vbr(&vi, ch, rate, q)) {
    vorbis_info_clear(&vi);
    return -1;
  }
  vorbis_comment_init(&vc);
  vorbis_comment_add_tag(&vc, "ENCODER", vendor);
  vorbis_analysis_init(&vd, &vi);
  vorbis_block_init(&vd, &vb);
  ogg_stream_init(&os, MYCO_SERIAL);
  {
    ogg_packet h, hc, hcode;
    vorbis_analysis_headerout(&vd, &vc, &h, &hc, &hcode);
    ogg_stream_packetin(&os, &h);
    ogg_stream_packetin(&os, &hc);
    ogg_stream_packetin(&os, &hcode);
    while (ogg_stream_flush(&os, &og)) put_page(out, &og);
  }
  long pos = 0;
  int eos = 0, ended = 0;
  while (!eos) {
    long n = frames - pos;
    if (n > 1024) n = 1024;
    if (n > 0) {
      float **buf = vorbis_analysis_buffer(&vd, (int)n);
      for (long i = 0; i < n; i++)
        for (int c = 0; c < ch; c++) buf[c][i] = interleaved[(pos + i) * ch + c];
      vorbis_analysis_wrote(&vd, (int)n);
      pos += n;
    } else if (!ended) {
      vorbis_analysis_wrote(&vd, 0);
      ended = 1;
    } else {
      break; /* everything flushed without an EOS page: not expected */
    }
    while (vorbis_analysis_blockout(&vd, &vb) == 1) {
      vorbis_analysis(&vb, NULL);
      vorbis_bitrate_addblock(&vb);
      while (vorbis_bitrate_flushpacket(&vd, &op)) {
        ogg_stream_packetin(&os, &op);
        while (!eos && ogg_stream_pageout(&os, &og)) {
          put_page(out, &og);
          if (ogg_page_eos(&og)) eos = 1;
        }
      }
    }
  }
  ogg_stream_clear(&os);
  vorbis_block_clear(&vb);
  vorbis_dsp_clear(&vd);
  vorbis_comment_clear(&vc);
  vorbis_info_clear(&vi);
  return out->failed ? -3 : 0;
}

static void le16(unsigned char *p, unsigned v) {
  p[0] = v & 255;
  p[1] = (v >> 8) & 255;
}
static void le32(unsigned char *p, unsigned v) {
  le16(p, v & 0xffff);
  le16(p + 2, v >> 16);
}

/* pcm48: interleaved float at 48 kHz, 1 or 2 channels. bitrate in bit/s; complexity 0..10. input_rate is the source's
 * rate, recorded in OpusHead (informational). Returns the pre-skip (>= 0), -1 when the encoder can't be created, -2
 * on an encode error, -3 when out of memory. */
int myco_opus_encode(const float *pcm48, int ch, long frames, int bitrate, int complexity, unsigned input_rate,
                     const char *vendor, myco_buf *out) {
  int err = 0;
  OpusEncoder *enc = opus_encoder_create(48000, ch, OPUS_APPLICATION_AUDIO, &err);
  if (err != OPUS_OK || !enc) return -1;
  opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
  opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(complexity));
  opus_encoder_ctl(enc, OPUS_SET_VBR(1));
  opus_int32 lookahead = 0;
  opus_encoder_ctl(enc, OPUS_GET_LOOKAHEAD(&lookahead));
  const long preskip = lookahead;

  ogg_stream_state os;
  ogg_page og;
  ogg_packet op;
  ogg_stream_init(&os, MYCO_SERIAL);
  unsigned char head[19];
  memcpy(head, "OpusHead", 8);
  head[8] = 1;
  head[9] = (unsigned char)ch;
  le16(head + 10, (unsigned)preskip);
  le32(head + 12, input_rate);
  le16(head + 16, 0); /* output gain */
  head[18] = 0;       /* channel mapping family 0: mono or stereo */
  memset(&op, 0, sizeof op);
  op.packet = head;
  op.bytes = 19;
  op.b_o_s = 1;
  ogg_stream_packetin(&os, &op);
  while (ogg_stream_flush(&os, &og)) put_page(out, &og);
  size_t vlen = strlen(vendor);
  unsigned char *tags = (unsigned char *)malloc(8 + 4 + vlen + 4);
  if (!tags) {
    opus_encoder_destroy(enc);
    ogg_stream_clear(&os);
    return -3;
  }
  memcpy(tags, "OpusTags", 8);
  le32(tags + 8, (unsigned)vlen);
  memcpy(tags + 12, vendor, vlen);
  le32(tags + 12 + vlen, 0);
  memset(&op, 0, sizeof op);
  op.packet = tags;
  op.bytes = (long)(8 + 4 + vlen + 4);
  op.packetno = 1;
  ogg_stream_packetin(&os, &op);
  while (ogg_stream_flush(&os, &og)) put_page(out, &og);
  free(tags);

  const int FRAME = 960; /* 20 ms */
  const long total = frames + preskip; /* samples the decoder sees, pre-skip included */
  float *block = (float *)malloc(sizeof(float) * FRAME * ch);
  if (!block) {
    opus_encoder_destroy(enc);
    ogg_stream_clear(&os);
    return -3;
  }
  unsigned char pkt[4000];
  long fed = 0; /* input frames consumed */
  long granule = 0;
  ogg_int64_t packetno = 2;
  while (granule < total) {
    for (int i = 0; i < FRAME; i++) {
      long s = fed + i;
      for (int c = 0; c < ch; c++) block[i * ch + c] = s < frames ? pcm48[s * ch + c] : 0.0f;
    }
    fed += FRAME;
    int n = opus_encode_float(enc, block, FRAME, pkt, sizeof pkt);
    if (n < 0) {
      free(block);
      opus_encoder_destroy(enc);
      ogg_stream_clear(&os);
      return -2;
    }
    granule += FRAME;
    memset(&op, 0, sizeof op);
    op.packet = pkt;
    op.bytes = n;
    op.packetno = packetno++;
    op.e_o_s = granule >= total;
    op.granulepos = op.e_o_s ? total : granule; /* end trimming */
    ogg_stream_packetin(&os, &op);
    while (ogg_stream_pageout(&os, &og)) put_page(out, &og);
  }
  while (ogg_stream_flush(&os, &og)) put_page(out, &og);
  free(block);
  opus_encoder_destroy(enc);
  ogg_stream_clear(&os);
  return out->failed ? -3 : (int)preskip;
}
