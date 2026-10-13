# Recordings store raw bytes, not decoded Signals

A Recording keeps the Device's raw byte stream with Host Timestamps; decoded Signals are a derived, discardable cache. During product bring-up the Frame Format is frequently wrong or incomplete, and storing raw bytes lets any past Recording be re-decoded with a corrected Frame Format. The cost is that opening a Recording requires decoding it, and a Recording is meaningless without a Frame Format.
