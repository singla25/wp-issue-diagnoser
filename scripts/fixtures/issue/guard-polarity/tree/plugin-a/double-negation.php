<?php
if ( ! ! function_exists( 'ereg' ) ) {
	ereg( 'a', 'b' );
}
if ( !!function_exists( 'ereg' ) ) {
	ereg( 'a', 'b' );
}
if ( ! ! ! function_exists( 'ereg' ) ) {
	ereg( 'a', 'b' );
}
if ( ! ! ! function_exists( 'ereg' ) ) {
	$x = 1;
} else {
	ereg( 'a', 'b' );
}
