<?php
if ( ! function_exists( 'each' ) ) {
	function each( &$a ) {
		return null;
	}
}
if ( ! function_exists( 'create_function' ) ) {
	function create_function( $args, $code ) {
		return null;
	}
} else {
	create_function( '$a', 'return $a;' );
}
