<?php
function pga_run( $a ) {
	if ( ! function_exists( 'ereg_replace' ) ) {
		return;
	}
	ereg_replace( 'a', 'b', $a );
}
if ( ! function_exists( 'ereg_replace' ) ) return;
ereg_replace( 'a', 'b', $a );
